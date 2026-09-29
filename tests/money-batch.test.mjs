// M6 batch invoicing: eligibility, one money request per job with a derived
// request ID, replay safety, per-job failures, manager-only access and the
// subrequest budget. In-memory revisioned store; fixed clock; nothing is sent
// and nothing reaches HighLevel from the server (the Invoicing screen starts
// the egc-invoice-issued lifecycle trigger; tests/invoice-highlevel-tag.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { BATCH_ITEM_COST, BATCH_MAX_ITEMS, batchItemRequestId, invoiceEligibility, issueInvoiceBatch, listInvoiceBatch } from '../functions/_lib/money-batch.js';
import { invoiceBatchHandlers } from '../functions/api/invoice-batch.js';
import { INVOICE_NUMBERS, mutateMoney } from '../functions/_lib/money-service.js';
import { MONEY_JOB_FIELDS } from '../functions/_lib/money-storage.js';
import { hubEligibilityFields } from '../functions/_lib/funnel-definitions.js';
import { readJobberGuardState } from '../functions/_lib/jobber-guard.js';

const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver on 2026-09-22
const ORIGIN = 'https://easygaragecleaning.com';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'synthetic.crew', role: 'crew', businessAccess: false };
const ENABLED = { MONEY_API_ENABLED: 'true' };
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const done = (id, extra = {}) => ({
  type: 'job', customerId: `customer-${id}`, customer: `Synthetic ${id}`, date: '2026-09-15', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-15T20:00:00.000Z', notify: true,
  estimate: { number: `EST-${id}`, status: 'accepted', amount: 1000, depositRequired: 500 }, ...extra,
});
const JOBS = {
  'job-ready': done('job-ready'),
  'job-partial': done('job-partial', { date: '2026-09-10', payment: { amount: 250, verified: true } }),
  'job-closing': done('job-closing', { status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-21', completedAt: undefined, postJobChecklist: { completedAt: '2026-09-21T22:00:00.000Z' } }),
  'job-void': done('job-void', { invoice: { number: 'INV-B-VOID', status: 'void', amount: 1000, voidedAt: '2026-09-18T15:00:00.000Z' } }),
  'job-company': done('job-company', { businessAccountId: 'acct-synthetic' }),
  'job-upcoming': done('job-upcoming', { status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-30', completedAt: undefined }),
  'job-cancelled': done('job-cancelled', { status: 'cancelled', pipelineStatus: 'cancelled' }),
  'job-test': done('job-test', { isTest: true }),
  'job-test2': done('job-test2', { test: true }),
  'job-issued': done('job-issued', { status: 'invoiced', pipelineStatus: 'invoiced', invoice: { number: 'INV-ISSUED', status: 'issued', amount: 1000, dueDate: '2026-09-29', issuedAt: '2026-09-16T15:00:00.000Z' } }),
  'job-paid': done('job-paid', { payment: { amount: 1000, verified: true } }),
  'job-review': done('job-review', { payment: { amount: 300 } }),
  'job-unknown': done('job-unknown', { estimate: { status: 'accepted', amount: 'call us' } }),
  'walk-1': done('walk-1', { type: 'walkthrough' }),
  '_egc_lock': done('_egc_lock'),
  'secure_profile': { recordType: 'employee_hub_v2' },
};

function fixture(jobs = JOBS) {
  const docs = new Map(Object.entries(jobs).map(([id, data]) => [`jobs/${id}`, { ...structuredClone(data), id, revision: `${id}-r0` }]));
  let n = 0, hook = null;
  const commits = [], reads = [];
  const store = {
    async read(collection, id) { reads.push(`${collection}/${id}`); return structuredClone(docs.get(`${collection}/${id}`) ?? null); },
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision || write.exists ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const rows = prefix => [...docs].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row);
  return { docs, store, commits, reads, rows, job: id => docs.get(`jobs/${id}`), beforeCommit: fn => { hook = fn; } };
}
const item = (f, jobId) => ({ jobId, expectedRevision: f.job(jobId).revision });
const batch = (f, jobIds, extra = {}) => ({ action: 'issue', requestId: randomUUID(), dueDate: '2026-10-06', items: jobIds.map(id => item(f, id)), ...extra });

test('eligibility: completed or closing customer jobs with a balance and no active invoice; never tests, cancellations or private records', async () => {
  const f = fixture(), list = await listInvoiceBatch(f.store, manager, NOW);
  assert.deepEqual([list.ok, list.authority, list.asOf, list.today, list.defaultDueDate, list.limits.maxItems], [true, 'employee_hub', NOW, '2026-09-22', '2026-09-29', BATCH_MAX_ITEMS]);
  assert.deepEqual(list.coverage, { complete: true, asOf: NOW });
  assert.deepEqual(list.candidates.map(row => row.jobId), ['job-partial', 'job-company', 'job-ready', 'job-void', 'job-closing'], 'oldest service date first');
  const partial = list.candidates[0];
  assert.deepEqual([partial.revision, partial.totalCents, partial.paidCents, partial.balanceCents, partial.invoiceStatus, partial.estimateApproved, partial.notify], ['job-partial-r0', 100000, 25000, 75000, 'not_issued', true, true]);
  assert.equal(list.candidates.find(row => row.jobId === 'job-void').invoiceStatus, 'void', 'a void invoice can be reissued');
  assert.equal(list.candidates.find(row => row.jobId === 'job-company').businessAccount, true, 'company jobs are flagged for the business hub');
  assert.deepEqual(list.review.map(row => [row.jobId, row.reason]), [['job-review', 'payment_needs_review'], ['job-unknown', 'money_needs_review']]);
  assert.deepEqual(list.open.map(row => [row.jobId, row.invoice.number, row.invoiceStatus, row.balanceCents, row.invoice.dueDate]), [['job-issued', 'INV-ISSUED', 'issued', 100000, '2026-09-29']]);
  assert.equal('sendable' in list, false, 'issued invoices are listed read-only; the Hub sends none of them');
  const excluded = ['job-upcoming', 'job-cancelled', 'job-test', 'job-test2', 'job-paid', 'walk-1', '_egc_lock', 'secure_profile'];
  for (const id of excluded) assert.ok(![...list.candidates, ...list.review, ...list.open].some(row => row.jobId === id), id);
  const reasons = Object.fromEntries(Object.keys(JOBS).map(id => [id, invoiceEligibility({ ...f.job(id) }, NOW).reason || 'eligible']));
  assert.deepEqual(reasons, {
    'job-ready': 'eligible', 'job-partial': 'eligible', 'job-closing': 'eligible', 'job-void': 'eligible', 'job-company': 'eligible', 'job-upcoming': 'not_completed', 'job-cancelled': 'job_closed',
    'job-test': 'test_job', 'job-test2': 'test_job', 'job-issued': 'already_invoiced', 'job-paid': 'nothing_due', 'job-review': 'payment_needs_review', 'job-unknown': 'money_needs_review',
    'walk-1': 'not_customer_job', '_egc_lock': 'not_customer_job', 'secure_profile': 'not_customer_job',
  });
  assert.equal(invoiceEligibility(null, NOW).reason, 'job_not_found');
  assert.equal(f.commits.length, 0, 'listing never writes');
  await assert.rejects(listInvoiceBatch({ jobs: async () => null }, manager, NOW), error => error.code === 'money_storage_incomplete' && error.status === 503, 'a failed scan is never an empty list');
});

test('test jobs are the ones the shared funnel definitions flag, and the money scan reads every such flag', () => {
  for (const field of hubEligibilityFields().filter(name => name !== 'isInternal' && name !== 'internalReason')) assert.ok(MONEY_JOB_FIELDS.includes(field), `the money jobs mask must read ${field}`);
  assert.ok(MONEY_JOB_FIELDS.includes('businessAccountId'), 'company jobs are flagged from the same scan');
  assert.equal(invoiceEligibility({ id: 'job-flag', ...done('job-flag', { isTest: 'yes' }) }, NOW).eligible, true, 'only an explicit true marks a test job');
  assert.equal(invoiceEligibility({ id: 'job-flag', ...done('job-flag', { isInternal: true, internalReason: 'case_study' }) }, NOW).eligible, true, 'internal jobs are still invoiced; only tests are skipped');
});

test('derived request IDs are RFC 4122 v5, stable per batch and job, and distinct across jobs and batches', async () => {
  const batchId = '3F2B8C1A-9D4E-4F60-8A7B-1C2D3E4F5A6B', id = await batchItemRequestId(batchId, 'job-ready');
  assert.match(id, UUID_V5);
  const space = Buffer.from('d2b6f0c46a1e4b5e9c3d7f1a2e9b4c60', 'hex'), hash = createHash('sha1').update(Buffer.concat([space, Buffer.from(`${batchId.toLowerCase()}:job-ready`)])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  assert.equal(id, `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  assert.equal(await batchItemRequestId(batchId.toLowerCase(), 'job-ready'), id);
  assert.notEqual(await batchItemRequestId(batchId, 'job-partial'), id);
  assert.notEqual(await batchItemRequestId(randomUUID(), 'job-ready'), id);
});

test('issuing a batch runs one audited money request per job and sends nothing', async () => {
  const f = fixture(), input = batch(f, ['job-ready', 'job-partial', 'job-closing']);
  const result = await issueInvoiceBatch(f.store, manager, input, NOW);
  assert.deepEqual([result.ok, result.action, result.replayed, result.requestId, result.dueDate], [true, 'issue', false, input.requestId, '2026-10-06']);
  assert.deepEqual(result.summary, { total: 3, issued: 3, replayed: 0, failed: 0, notAttempted: 0 });
  for (const row of result.results) {
    assert.deepEqual([row.ok, row.status, row.replayed, row.invoice.status, row.invoice.dueDate], [true, 'issued', false, row.jobId === 'job-partial' ? 'partial' : 'issued', '2026-10-06'], row.jobId);
    assert.equal(row.requestId, await batchItemRequestId(input.requestId, row.jobId));
    const job = f.job(row.jobId);
    assert.deepEqual([job.moneyRequestId, job.invoice.status, job.invoice.issuedBy, job.invoice.dueDate, row.revision], [row.requestId, 'issued', 'tylerg', '2026-10-06', job.revision]);
    assert.equal(f.docs.get(`moneyOperations/${row.requestId}`).action, 'invoice.issue');
  }
  assert.deepEqual(result.results.map(row => [row.jobId, row.invoice.number, row.invoice.amountCents, row.balanceCents]), [['job-ready', 'INV--READY', 100000, 100000], ['job-partial', 'INV-ARTIAL', 100000, 75000], ['job-closing', 'INV-LOSING', 100000, 100000]]);
  assert.equal(f.job('job-ready').status, 'invoiced', 'completed work moves to invoiced, as invoice.issue always does');
  const receipt = f.docs.get(`moneyOperations/${input.requestId.toLowerCase()}`);
  assert.deepEqual([receipt.kind, receipt.actorId, receipt.dueDate, receipt.jobIds], ['invoice.batch', 'tylerg', '2026-10-06', ['job-ready', 'job-partial', 'job-closing']]);
  assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.rows('hub_audit/').map(row => row.action), ['money.invoice.issue', 'money.invoice.issue', 'money.invoice.issue'], 'each invoice has its own audit entry');
  assert.deepEqual(f.rows('message_sends/'), []); assert.deepEqual(f.rows('confirm_tokens/'), []);
  const after = await listInvoiceBatch(f.store, manager, NOW);
  assert.ok(!after.candidates.some(row => ['job-ready', 'job-partial', 'job-closing'].includes(row.jobId)), 'issued jobs leave the list');
  assert.deepEqual(after.open.map(row => row.jobId).sort(), ['job-closing', 'job-issued', 'job-partial', 'job-ready'], 'and show as open invoices');
});

test('replaying a batch issues nothing twice, even after the jobs change; another payload under the same ID is refused', async () => {
  const f = fixture(), input = batch(f, ['job-ready', 'job-partial']);
  const first = await issueInvoiceBatch(f.store, owner, input, NOW), writes = f.commits.length;
  const replay = await issueInvoiceBatch(f.store, owner, structuredClone(input), NOW);
  assert.equal(f.commits.length, writes, 'a replay writes nothing');
  assert.deepEqual([replay.replayed, replay.summary], [true, { total: 2, issued: 2, replayed: 2, failed: 0, notAttempted: 0 }]);
  assert.deepEqual(replay.results.map(row => [row.jobId, row.invoice.number, row.revision]), first.results.map(row => [row.jobId, row.invoice.number, row.revision]));
  // A later money change on job-ready (a recorded check) supersedes its batch request.
  await mutateMoney(f.store, owner, { action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-ready', expectedRevision: f.job('job-ready').revision, amountCents: 10000, method: 'check', reference: 'Synthetic check 101' }, NOW);
  const changed = f.commits.length, later = await issueInvoiceBatch(f.store, owner, structuredClone(input), NOW);
  assert.deepEqual(later.results.map(row => [row.jobId, row.ok, row.status, Boolean(row.changedSince)]), [['job-ready', true, 'issued', true], ['job-partial', true, 'issued', false]]);
  assert.equal(f.commits.length, changed, 'a changed job is reported, never issued again');
  await assert.rejects(issueInvoiceBatch(f.store, owner, { ...input, dueDate: '2026-10-09' }, NOW), error => error.code === 'money_idempotency_conflict' && error.status === 409);
  await assert.rejects(issueInvoiceBatch(f.store, manager, input, NOW), error => error.code === 'money_idempotency_conflict', 'another person cannot replay a batch');
  const again = await issueInvoiceBatch(f.store, owner, batch(f, ['job-ready', 'job-partial']), NOW);
  assert.deepEqual(again.results.map(row => [row.jobId, row.code, row.details?.reason]), [['job-ready', 'money_batch_not_eligible', 'already_invoiced'], ['job-partial', 'money_batch_not_eligible', 'already_invoiced']], 'a new batch never reissues an active invoice');
  assert.equal(f.commits.length, changed + 1, 'only the new batch receipt was written');
});

test('a lost batch replayed after Denver midnight returns the invoices it issued, though its due date has passed', async () => {
  // The batch is due today (Denver, 2026-09-22). Its answer is lost after two
  // jobs were issued; the third was not attempted (the storage budget ran out).
  const f = fixture(), input = batch(f, ['job-ready', 'job-partial', 'job-closing'], { dueDate: '2026-09-22' });
  const budget = n => { let calls = 0; return () => (calls++ < n ? Infinity : 0); };
  const first = await issueInvoiceBatch(f.store, manager, input, NOW, { left: budget(2) });
  assert.deepEqual(first.results.map(row => row.ok ? 'issued' : row.code), ['issued', 'issued', 'money_batch_not_attempted']);
  const writes = f.commits.length, AFTER = '2026-09-23T07:30:00.000Z'; // 01:30 on 2026-09-23 in Denver
  // The screen retries the same request after midnight; the hold is not read for what the batch already issued.
  let holdReads = 0;
  const replay = await issueInvoiceBatch(f.store, manager, structuredClone(input), AFTER, { billing: async () => { holdReads += 1; return null; } });
  assert.deepEqual([replay.replayed, replay.dueDate], [true, '2026-09-22'], 'the saved batch replays instead of failing money_invalid_due_date');
  assert.deepEqual(replay.results.map(row => [row.jobId, row.ok, row.ok ? row.replayed : row.code]), [['job-ready', true, true], ['job-partial', true, true], ['job-closing', false, 'money_invalid_due_date']],
    'each issued invoice comes back with its request ID, so the screen can start its HighLevel trigger; the job it never issued is not issued with a past due date');
  assert.deepEqual(replay.results.slice(0, 2).map(row => [row.requestId, row.invoice.number, row.invoice.dueDate]), first.results.slice(0, 2).map(row => [row.requestId, row.invoice.number, row.invoice.dueDate]));
  assert.equal(replay.results[2].error, 'Choose a payment due date of today or later.');
  assert.deepEqual([f.commits.length, f.job('job-closing').invoice, holdReads], [writes, undefined, 1], 'nothing new is written; the hold is read once, for the job not yet issued');
  // A new batch with that due date is refused before anything is written, as before.
  await assert.rejects(issueInvoiceBatch(f.store, manager, batch(f, ['job-closing'], { dueDate: '2026-09-22' }), AFTER), error => error.code === 'money_invalid_due_date' && error.status === 400);
  assert.equal(f.commits.length, writes);
  // Through the API as well: the lost batch comes back 200 after midnight.
  const handlers = invoiceBatchHandlers({ session: async () => manager, storage: () => f.store, now: () => new Date(AFTER) });
  const response = await handlers.post({ request: new Request(`${ORIGIN}/api/invoice-batch`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), env: ENABLED });
  const body = await response.json();
  assert.deepEqual([response.status, body.replayed, body.summary], [200, true, { total: 3, issued: 2, replayed: 2, failed: 1, notAttempted: 0 }]);
});

test('one conflicting or ineligible job never blocks the others', async () => {
  const f = fixture(), input = batch(f, ['job-ready', 'job-issued', 'job-partial', 'job-upcoming', 'job-void', 'job-test']);
  input.items[2].expectedRevision = 'stale-revision';
  f.beforeCommit(async writes => {
    // The batch receipt commits first; then another person edits job-void mid-batch.
    if (writes.some(write => write.collection === 'moneyOperations' && write.patch.kind === 'invoice.batch')) f.beforeCommit(async next => {
      if (next.some(write => write.id === 'job-ready')) f.docs.set('jobs/job-void', { ...f.job('job-void'), revision: 'changed-meanwhile' });
    });
  });
  const result = await issueInvoiceBatch(f.store, manager, input, NOW);
  assert.deepEqual(result.results.map(row => [row.jobId, row.ok, row.status || row.code, row.details?.reason || '']), [
    ['job-ready', true, 'issued', ''], ['job-issued', false, 'money_batch_not_eligible', 'already_invoiced'], ['job-partial', false, 'money_revision_conflict', ''],
    ['job-upcoming', false, 'money_batch_not_eligible', 'not_completed'], ['job-void', false, 'money_revision_conflict', ''], ['job-test', false, 'money_batch_not_eligible', 'test_job'],
  ]);
  assert.deepEqual(result.summary, { total: 6, issued: 1, replayed: 0, failed: 5, notAttempted: 0 });
  assert.equal(result.results[1].error, 'This job already has an active invoice.');
  assert.equal(f.job('job-partial').invoice, undefined); assert.equal(f.job('job-void').invoice.status, 'void');
  const broken = fixture(), crash = { ...broken.store, read: async (collection, id) => { if (id === 'job-partial') throw new Error('private storage detail'); return broken.store.read(collection, id); } };
  const partial = await issueInvoiceBatch(crash, manager, batch(broken, ['job-partial', 'job-ready']), NOW);
  assert.deepEqual(partial.results.map(row => [row.jobId, row.ok, row.code || row.status]), [['job-partial', false, 'money_unavailable'], ['job-ready', true, 'issued']]);
  assert.doesNotMatch(JSON.stringify(partial), /private storage detail/);
});

test('batch input is validated before anything is written', async () => {
  const f = fixture(), bad = async (input, code) => assert.rejects(issueInvoiceBatch(f.store, manager, input, NOW), error => error.code === code && error.status === 400, JSON.stringify(input).slice(0, 120));
  await bad({ ...batch(f, ['job-ready']), extra: true }, 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), action: 'send' }, 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), requestId: 'not-a-uuid' }, 'money_batch_invalid');
  await bad(batch(f, ['job-ready'], { dueDate: '2026-09-21' }), 'money_invalid_due_date');
  await bad(batch(f, ['job-ready'], { dueDate: '2026-02-30' }), 'money_invalid_due_date');
  await bad(batch(f, []), 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), items: [{ jobId: 'job-ready' }] }, 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), items: [{ ...item(f, 'job-ready'), amountCents: 1 }] }, 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), items: [{ jobId: 'secure_profile', expectedRevision: 'x' }] }, 'money_batch_invalid');
  await bad(batch(f, ['job-ready', 'job-ready']), 'money_batch_invalid');
  await bad({ ...batch(f, ['job-ready']), items: Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, index) => ({ jobId: `job-${index}`, expectedRevision: 'r' })) }, 'money_batch_too_large');
  assert.equal(await issueInvoiceBatch(f.store, manager, batch(f, ['job-ready'], { dueDate: '2026-09-22' }), NOW).then(result => result.summary.issued), 1, 'due today is allowed');
});

test('only an owner or manager with business access can list or issue', async () => {
  const f = fixture();
  for (const [actor, code, status] of [[null, 'money_sign_in_required', 401], [crew, 'money_forbidden', 403], [{ ...manager, businessAccess: false }, 'money_forbidden', 403], [{ user: 'synthetic.sales', role: 'manager', businessAccess: true }, 'money_forbidden', 403]]) {
    await assert.rejects(listInvoiceBatch(f.store, actor, NOW), error => error.code === code && error.status === status);
    await assert.rejects(issueInvoiceBatch(f.store, actor, batch(f, ['job-ready']), NOW), error => error.code === code && error.status === status);
  }
  assert.equal(f.commits.length, 0);
});

async function api(f, { viewer = manager, env = ENABLED } = {}) {
  const handlers = invoiceBatchHandlers({ session: async () => viewer, storage: () => f.store, now: () => new Date(NOW) });
  const call = async (method, body, headers = {}, path = '/api/invoice-batch') => {
    const init = { method, headers: { Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) };
    const response = await handlers[method === 'GET' ? 'get' : 'post']({ request: new Request(ORIGIN + path, init), env });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return call;
}

test('the API is same-origin JSON, manager-only, and issues only while MONEY_API_ENABLED is on', async () => {
  const f = fixture(), call = await api(f);
  const list = await call('GET');
  assert.deepEqual([list.status, list.body.enabled, list.body.viewer, 'messaging' in list.body], [200, true, { id: 'tylerg' }, false]);
  assert.equal(list.headers.get('Cache-Control'), 'no-store'); assert.equal(list.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await call('GET', undefined, {}, '/api/invoice-batch?view=all').then(r => [r.status, r.body.code]), [400, 'money_query_invalid']);
  assert.deepEqual(await call('GET', undefined, { 'Sec-Fetch-Site': 'same-site' }).then(r => [r.status, r.body.code]), [403, 'money_origin_forbidden']);
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example.invalid' }]) assert.deepEqual(await call('POST', batch(f, ['job-ready']), headers).then(r => [r.status, r.body.code]), [403, 'money_origin_forbidden']);
  assert.deepEqual(await call('POST', batch(f, ['job-ready']), { 'Content-Type': 'text/plain' }).then(r => [r.status, r.body.code]), [415, 'money_json_required']);
  assert.deepEqual(await call('POST', JSON.stringify({ ...batch(f, ['job-ready']), pad: 'x'.repeat(16001) })).then(r => [r.status, r.body.code]), [413, 'money_request_too_large']);
  assert.deepEqual(await call('POST', '{"action":').then(r => [r.status, r.body.code]), [400, 'money_json_invalid']);
  assert.equal(f.commits.length, 0);
  const off = await api(f, { env: {} });
  assert.deepEqual(await off('POST', batch(f, ['job-ready'])).then(r => [r.status, r.body.code]), [404, 'money_api_disabled']);
  assert.deepEqual(await off('GET').then(r => [r.status, r.body.enabled]), [200, false], 'the list stays readable while writes are off');
  for (const viewer of [null, crew]) {
    const denied = await api(f, { viewer });
    assert.deepEqual(await denied('GET').then(r => r.status), viewer ? 403 : 401);
    assert.deepEqual(await denied('POST', batch(f, ['job-ready'])).then(r => r.status), viewer ? 403 : 401);
  }
  const issued = await call('POST', batch(f, ['job-ready']));
  assert.deepEqual([issued.status, issued.body.summary.issued], [200, 1]);
  const broken = invoiceBatchHandlers({ session: async () => manager, storage: () => ({ jobs: async () => { throw new Error('private stack detail'); } }), now: () => new Date(NOW) });
  const failed = await broken.get({ request: new Request(`${ORIGIN}/api/invoice-batch`, { headers: { Origin: ORIGIN } }), env: ENABLED });
  const body = await failed.json();
  assert.deepEqual([failed.status, body.code], [503, 'money_unavailable']); assert.doesNotMatch(JSON.stringify(body), /private stack/);
});

test('a batch stops before the subrequest budget runs out and reports the rest as not attempted', async () => {
  const ids = ['job-ready', 'job-partial', 'job-closing', 'job-void', 'job-company'];
  for (const [budget, attempted] of [[undefined, 5], ['30', 3], ['12', 5], ['900', 5]]) {
    const f = fixture(), call = await api(f, { env: { ...ENABLED, ...(budget ? { MONEY_BATCH_SUBREQUEST_BUDGET: budget } : {}) } });
    const input = batch(f, ids), result = (await call('POST', input)).body;
    assert.deepEqual(result.results.map(row => row.ok ? 'issued' : row.code), ids.map((_, index) => index < attempted ? 'issued' : 'money_batch_not_attempted'), String(budget));
    assert.equal(result.summary.notAttempted, ids.length - attempted);
    assert.equal(ids.filter(id => f.job(id).invoice?.status === 'issued').length, attempted, 'nothing is half-issued');
    const rest = batch(f, ids.slice(attempted));
    if (rest.items.length) assert.equal((await call('POST', rest)).body.summary.issued, ids.length - attempted, 'the rest go out in a new batch');
  }
});

test('a job whose new invoice number is taken mid-save still fits the budget reserved for it', async () => {
  const ids = ['job-ready', 'job-partial', 'job-closing', 'job-company'];
  for (let budget = 30; budget <= 60; budget += 1) {
    const f = fixture();
    let calls = 0;
    // Another job takes every invoice number this batch reserves just before
    // the save, so each job re-plans once and then gives up (the costliest path).
    const store = {
      jobs: f.store.jobs,
      read: (...args) => { calls += 1; return f.store.read(...args); },
      commit: writes => {
        calls += 1;
        for (const write of writes) if (write.collection === INVOICE_NUMBERS && !f.docs.has(`${INVOICE_NUMBERS}/${write.id}`)) f.docs.set(`${INVOICE_NUMBERS}/${write.id}`, { number: write.patch.number, jobId: 'job-elsewhere', id: write.id, revision: 'taken' });
        return f.store.commit(writes);
      },
    };
    const handlers = invoiceBatchHandlers({ session: async () => manager, storage: () => store, now: () => new Date(NOW) });
    const response = await handlers.post({ request: new Request(`${ORIGIN}/api/invoice-batch`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(batch(f, ids)) }), env: { ...ENABLED, MONEY_BATCH_SUBREQUEST_BUDGET: String(budget) } });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(calls <= budget, `${calls} store calls within a budget of ${budget}`);
    const attempted = result.results.filter(row => row.code !== 'money_batch_not_attempted');
    assert.ok(attempted.length >= 2, `budget ${budget} still attempts jobs`);
    for (const row of attempted) assert.deepEqual([row.ok, row.code], [false, 'money_invoice_number_unavailable'], String(budget));
    assert.equal(ids.filter(id => f.job(id).invoice?.status === 'issued').length, 0, 'nothing is half-issued');
  }
});

test('crew tips (TIPS) never count toward the balance: a tipped job is invoiced for what is still owed, and unverified tips send it to review', async () => {
  const tip = { sessionId: 'cs_test_synthetictip01', paymentIntentId: 'pi_synthetictip01', amountCents: 5000, amount: 50, verifiedAt: '2026-09-15T21:00:00.000Z', recordedBy: 'stripe' };
  const f = fixture({ 'job-tipped': done('job-tipped', { payment: { amount: 250, verified: true, tips: [tip] } }), 'job-tip-unverified': done('job-tip-unverified', { payment: { amount: 250, tips: [tip] } }) });
  const list = await listInvoiceBatch(f.store, manager, NOW);
  assert.deepEqual(list.candidates.map(row => [row.jobId, row.totalCents, row.paidCents, row.balanceCents]), [['job-tipped', 100000, 25000, 75000]], 'the $50 tip is neither paid toward the job nor owed');
  assert.deepEqual(list.review.map(row => [row.jobId, row.reason]), [['job-tip-unverified', 'money_needs_review']], 'tips on an unverified payment leave the paid total unknown');
  const result = await issueInvoiceBatch(f.store, manager, batch(f, ['job-tipped', 'job-tip-unverified']), NOW);
  assert.deepEqual(result.results.map(row => row.ok ? [row.jobId, row.invoice.amountCents, row.balanceCents] : [row.jobId, row.code, row.details.reason]), [['job-tipped', 100000, 75000], ['job-tip-unverified', 'money_batch_not_eligible', 'money_needs_review']]);
  assert.deepEqual([f.job('job-tipped').invoice.paidCents, f.job('job-tipped').invoice.balanceCents, f.job('job-tipped').payment], [25000, 75000, { amount: 250, verified: true, tips: [tip] }], 'the invoice leaves the tip out, and the payment and its tips are untouched');
});

test('a replay reads the billing hold for its first job not yet issued only with a whole issue (BATCH_ITEM_COST calls) left besides it', async () => {
  const ids = ['job-ready', 'job-partial', 'job-closing'], runs = [];
  for (let budget = 1; budget <= 60; budget += 1) {
    // The first request issues job-ready only (the rest are not attempted) and its answer is lost.
    const f = fixture(), input = batch(f, ids);
    let first = 0;
    await issueInvoiceBatch(f.store, manager, input, NOW, { left: () => (first++ < 1 ? Infinity : 0) });
    // The retry replays job-ready from its receipt, then needs the hold for job-partial.
    let calls = 0, hold = null;
    const store = { jobs: f.store.jobs, read: (...args) => { calls += 1; return f.store.read(...args); }, commit: writes => { calls += 1; return f.store.commit(writes); } };
    const left = [], replay = await issueInvoiceBatch(store, manager, structuredClone(input), NOW, {
      left: () => { left.push(budget - calls); return budget - calls; },
      billing: async () => { const before = calls, state = await readJobberGuardState(store); hold = calls - before; return state; },
    });
    assert.ok(calls <= budget, `${calls} store calls within a budget of ${budget}`);
    if (replay.results[0].ok) assert.equal(replay.results[0].replayed, true);
    runs.push({ attempted: replay.results.map(row => row.code !== 'money_batch_not_attempted'), left: left[1], next: left[2], hold, issued: f.job('job-partial').invoice?.status === 'issued' });
  }
  const at = runs.findIndex(run => run.attempted[1]), run = runs[at], before = runs[at - 1];
  assert.ok(at > 0, 'small budgets attempt nothing new');
  assert.deepEqual([run.attempted, run.left, run.hold, run.left - run.hold, run.issued], [[true, true, false], BATCH_ITEM_COST + 1, 1, BATCH_ITEM_COST, true],
    'job-partial starts with BATCH_ITEM_COST calls left besides the one hold read, and is issued');
  assert.deepEqual([before.attempted, before.left, before.hold, before.issued], [[true, false, false], BATCH_ITEM_COST, null, false], 'with BATCH_ITEM_COST calls left it is not attempted and the hold is never read');
  // Once the hold is loaded, the next job needs only a whole issue.
  const next = runs.find(row => row.attempted[2]);
  assert.deepEqual([next.attempted, next.next], [[true, true, true], BATCH_ITEM_COST], 'job-closing starts with exactly BATCH_ITEM_COST calls left');
});
