import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRefusal, parseArgs, planChangeOrderBackfill, runChangeOrderBackfill } from '../scripts/backfill-change-orders.mjs';
import { billedChangeCents, respondToDecision } from '../functions/_lib/change-orders.js';
import { customerMoneyState } from '../functions/_lib/customer-payments.js';
import { customerMoneyTotals } from '../functions/_lib/money-core.js';
import { mutateMoney } from '../functions/_lib/money-service.js';

const NOW = '2026-09-28T18:00:00.000Z';
const RUN = '00000000-0000-4000-8000-000000000002';
const REQUEST = '2b7f0c1e-5a4d-4c3b-9e8f-7a6b5c4d3e2f';
// A portal approval saved while billing was off: approved, priced, no line.
const answered = (extra = {}) => ({ id: 'decision-freezer', title: 'Haul the old freezer', details: 'Synthetic crew note.', priceDelta: 150, status: 'approved', promptedAt: '2026-09-20T16:00:00.000Z', respondedAt: '2026-09-20T16:10:00.000Z', responseBy: 'Synthetic Customer', responseNote: '', responseSource: 'customer_portal', responseRequestId: REQUEST, ...extra });
const job = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'c1', serviceType: 'Garage Turnaround', total: 1000, status: 'in_progress',
  estimate: { number: 'EST-1', status: 'approved', amount: 1000, depositRequired: 500, revision: 2 },
  payment: { amount: 500, verified: true }, customerDecisions: [answered()], approvedChangeTotal: 150, ...extra,
});
const JOBS = {
  open: job(),
  'stripe-invoice': job({ invoice: { number: 'INV-TWO', status: 'partial', amount: 1000, paid: 500, balance: 500 } }),
  'hub-invoice': job({ invoice: { number: 'INV-THREE', status: 'issued', amount: 1150, amountCents: 115000, approvedChangeCents: 15000, balance: 650, lineItems: [{ id: 'legacy-1', totalCents: 100000 }, { id: 'change-decision-freezer', totalCents: 15000 }] } }),
  'finished-after': job({ status: 'completed', completedAt: '2026-09-20T18:00:00.000Z', payment: { amount: 1000, verified: true }, invoice: { number: 'INV-FOUR', status: 'paid', amount: 1000, paid: 1000, balance: 0 } }),
  'answered-late': job({ status: 'paid', pipelineStatus: 'paid', completedAt: '2026-09-20T16:00:00.000Z' }),
  'finished-undated': job({ status: 'completed' }),
  'bad-price': job({ customerDecisions: [answered({ priceDelta: '$150' })] }),
  twins: job({ customerDecisions: [answered(), answered({ title: 'Duplicate' })] }),
  cancelled: job({ status: 'cancelled' }),
  'no-evidence': job({ customerDecisions: [answered({ respondedAt: '' })] }),
  mismatch: job({ invoice: { number: 'INV-FIVE', status: 'issued', amount: 999 } }),
  billed: { ...job({ customerDecisions: [answered({ status: 'pending', respondedAt: '', responseBy: '', responseSource: undefined, responseRequestId: undefined })] }) },
  'hub-answered': job({ customerDecisions: [answered({ responseSource: 'hub' })] }),
  quiet: job({ customerDecisions: [answered({ status: 'declined' }), answered({ id: 'decision-free', priceDelta: 0 })], approvedChangeTotal: 0 }),
  walk: { type: 'walkthrough', customerDecisions: [answered()] },
  _egc_schedule_lock_2026_09_22: { recordType: 'schedule_lock' },
};
// A job the live flow billed while the flag was on is already current.
JOBS.billed = { ...JOBS.billed, ...respondToDecision(JOBS.billed, { decisionId: 'decision-freezer', response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: REQUEST, priceDeltaCents: 15000 }, { billing: true, now: '2026-09-27T16:00:00.000Z' }).patch };

function fixture(jobs = JOBS) {
  const docs = new Map(Object.entries(jobs).map(([id, row]) => [`jobs/${id}`, { ...structuredClone(row), id, revision: `${id}-r0` }]));
  let n = 0, hook = null;
  const commits = [];
  const store = {
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  return { docs, store, commits, job: id => docs.get(`jobs/${id}`), beforeCommit: fn => { hook = fn; } };
}

test('the dry run plans a line for each unbilled portal approval, lists unclear jobs for review and writes nothing', async () => {
  // The owner reviewed the settled finished job (finished-after) and opted it in.
  const f = fixture(), report = await runChangeOrderBackfill(f.store, { now: NOW, runId: RUN, includeFinished: true });
  assert.equal(report.mode, 'dry_run'); assert.equal(f.commits.length, 0);
  assert.deepEqual(report.preview.map(row => [row.id, row.invoice, row.finished, row.lines]), [
    ['finished-after', 'raised', true, [{ decisionId: 'decision-freezer', totalCents: 15000 }]],
    ['hub-invoice', 'already_included', false, [{ decisionId: 'decision-freezer', totalCents: 15000 }]],
    ['open', 'none', false, [{ decisionId: 'decision-freezer', totalCents: 15000 }]],
    ['stripe-invoice', 'raised', false, [{ decisionId: 'decision-freezer', totalCents: 15000 }]],
  ]);
  assert.deepEqual(report.jobs.needsReview.map(row => [row.id, row.issues.map(issue => issue.code)]), [
    ['answered-late', ['answered_after_completion']], ['bad-price', ['price_invalid']], ['cancelled', ['job_closed']], ['finished-undated', ['completion_time_unknown']],
    ['mismatch', ['invoice_amount_mismatch']], ['no-evidence', ['answer_evidence_missing']], ['twins', ['decision_ambiguous', 'decision_ambiguous', 'stored_total_mismatch']],
  ]);
  // Two approvals of $150 under one id, but $150 saved: the saved total is reported with both figures.
  assert.deepEqual(report.jobs.needsReview.find(row => row.id === 'twins').issues.at(-1), { decisionId: '', code: 'stored_total_mismatch', storedCents: 15000, derivedCents: 30000 });
  assert.deepEqual([report.jobs.scanned, report.jobs.skippedRecords, report.jobs.current], [16, 2, 3]);
  assert.deepEqual(report.writes, { planned: 4, committed: 0, changedDuringRun: [], receipts: [] });
  const rows = await f.store.jobs();
  assert.throws(() => planChangeOrderBackfill(rows), { code: 'change_order_backfill_now_required' });
});

test('--apply adds backfilled lines with the approval evidence in revision-checked, audited commits, then a rerun is a no-op', async () => {
  const f = fixture(), before = structuredClone(f.job('stripe-invoice'));
  const report = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN, includeFinished: true });
  assert.equal(report.mode, 'apply'); assert.deepEqual([report.writes.planned, report.writes.committed, report.writes.receipts.length], [4, 4, 1]);
  const [writes] = f.commits;
  assert.deepEqual(writes.filter(write => write.collection === 'jobs').map(write => [write.id, write.revision, Object.keys(write.patch).sort()]), [
    ['finished-after', 'finished-after-r0', ['approvedChangeTotal', 'changeOrders', 'customerDecisions', 'invoice']],
    ['hub-invoice', 'hub-invoice-r0', ['approvedChangeTotal', 'changeOrders', 'customerDecisions']],
    ['open', 'open-r0', ['approvedChangeTotal', 'changeOrders', 'customerDecisions']],
    ['stripe-invoice', 'stripe-invoice-r0', ['approvedChangeTotal', 'changeOrders', 'customerDecisions', 'invoice']],
  ]);
  assert.equal(writes.filter(write => write.collection === 'hub_audit').length, 4);
  assert.ok(writes.every(write => write.collection !== 'hub_audit' || write.patch.action === 'money.change_order.backfill'));
  assert.equal(writes.find(write => write.collection === 'moneyOperations').patch.runId, RUN);
  const saved = f.job('stripe-invoice'), [line] = saved.changeOrders;
  assert.deepEqual(line, {
    id: 'change-decision-freezer', kind: 'fee', source: 'customer_decision', decisionId: 'decision-freezer', name: 'Approved change: Haul the old freezer', description: 'Synthetic crew note.',
    quantity: 1, unitCents: 15000, totalCents: 15000, amount: 150, approvedAt: '2026-09-20T16:10:00.000Z', approvedBy: 'Synthetic Customer', requestId: REQUEST, approvalSource: 'customer_portal',
    backfilled: true, backfilledAt: NOW, backfilledBy: 'change-order-backfill',
  });
  assert.equal(saved.customerDecisions[0].changeOrderId, 'change-decision-freezer'); assert.equal(saved.approvedChangeTotal, 150);
  assert.deepEqual(saved.invoice, { ...before.invoice, amount: 1150, balance: 650, updatedAt: NOW });
  // The portal balance and money-core now agree, closing the gap.
  assert.deepEqual(customerMoneyState(before), { total: 1000, paid: 500, balance: 500 });
  for (const id of ['open', 'stripe-invoice', 'hub-invoice']) {
    assert.deepEqual(customerMoneyState(f.job(id)), { total: 1150, paid: 500, balance: 650 }, id);
    assert.equal(customerMoneyTotals(f.job(id)).totalCents, 115000, id);
  }
  assert.deepEqual(f.job('hub-invoice').invoice, JOBS['hub-invoice'].invoice, 'an invoice that already includes the change is left as it is');
  assert.deepEqual([f.job('finished-after').invoice.status, f.job('finished-after').invoice.balance], ['partial', 150]);
  for (const id of ['answered-late', 'mismatch', 'billed', 'quiet']) assert.equal(f.job(id).revision, `${id}-r0`, `${id} is not written`);
  const again = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.equal(again.writes.planned, 0); assert.equal(again.jobs.current, 7); assert.equal(f.commits.length, 1);
});

test('a job saved during the run is skipped and reported while the rest of its batch is written', async () => {
  const f = fixture();
  f.beforeCommit(() => { f.job('open').revision = 'changed-by-someone-else'; });
  const report = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN, includeFinished: true });
  assert.deepEqual(report.writes.changedDuringRun, ['open']); assert.equal(report.writes.committed, 3);
  assert.equal(f.job('open').changeOrders, undefined);
});

test('a backfilled line can be voided from the Hub like any billed change', async () => {
  const f = fixture({ open: JOBS.open });
  await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.equal(billedChangeCents(f.job('open')), 15000);
  const owner = { user: 'zacb', role: 'owner', businessAccess: true };
  const result = await mutateMoney(f.store, owner, { action: 'change_order.void', requestId: '3c8f0c1e-5a4d-4c3b-9e8f-7a6b5c4d3e2f', jobId: 'open', expectedRevision: f.job('open').revision, changeOrderId: 'change-decision-freezer', reason: 'Synthetic: never hauled' }, NOW);
  assert.equal(result.ok, true); assert.equal(billedChangeCents(f.job('open')), 0); assert.equal(f.job('open').approvedChangeTotal, 0);
  assert.equal(customerMoneyTotals(f.job('open')).totalCents, 100000);
});

test('arguments default to a dry run and refuse ambiguous modes', () => {
  assert.deepEqual(parseArgs([]), { apply: false, report: '', help: false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply: true, report: 'out.json', help: false });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either --dry-run or --apply/);
  assert.throws(() => parseArgs(['--report']), /Unknown or incomplete argument/);
  assert.throws(() => parseArgs(['--force']), /Unknown or incomplete argument/);
});

test('by default a settled finished job is held for review, so a closed balance never reopens without the owner opting in', async () => {
  const f = fixture(), report = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.deepEqual(report.jobs.needsReview.find(row => row.id === 'finished-after'), { id: 'finished-after', issues: [{ decisionId: '', code: 'job_finished' }] });
  assert.deepEqual(report.preview.map(row => row.id), ['hub-invoice', 'open', 'stripe-invoice']);
  assert.deepEqual([report.writes.planned, report.writes.committed], [3, 3]);
  assert.equal(f.job('finished-after').revision, 'finished-after-r0', 'the paid invoice stays paid');
  assert.deepEqual([f.job('finished-after').invoice.status, f.job('finished-after').invoice.balance, customerMoneyState(f.job('finished-after')).balance], ['paid', 0, 0]);
  // A finished job that still owes money is not settled, so it is planned as before (the approval came before completion).
  const owing = planChangeOrderBackfill([{ ...JOBS['finished-after'], id: 'owing', revision: 'r', payment: { amount: 500, verified: true }, invoice: { number: 'INV-SIX', status: 'partial', amount: 1000, paid: 500, balance: 500 } }], NOW);
  assert.deepEqual([owing.writes.map(row => [row.id, row.finished, row.invoice]), owing.report.needsReview], [[['owing', true, 'raised']], []]);
  // After review the owner opts in: the held job is written.
  const opted = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN, includeFinished: true });
  assert.deepEqual(opted.preview.map(row => [row.id, row.finished]), [['finished-after', true]]);
  assert.deepEqual([f.job('finished-after').invoice.status, f.job('finished-after').invoice.balance], ['partial', 150]);
});

test('a backfilled invoice raise reads money-core applied payments and settles the invoice as a live approval does', () => {
  const invoice = { number: 'INV-TWO', status: 'partial', amount: 1000, paid: 500, balance: 500 };
  const plan = row => planChangeOrderBackfill([{ ...row, id: 'job-x', revision: 'r' }], NOW).writes[0].patch;
  // $1,200 is recorded against the $1,000 invoice, so the +$150 line leaves nothing owed.
  assert.deepEqual(plan(job({ payment: { amount: 1200, verified: true }, invoice })).invoice, { ...invoice, status: 'paid', amount: 1150, paid: 1200, balance: 0, updatedAt: NOW });
  assert.equal(plan(job({ payment: { amount: 1200, verified: false }, invoice })).invoice.status, 'pending_verification');
  // A $50 card tip never counts toward the balance.
  const sessions = [{ sessionId: 'cs_test_synthetic_deposit', paymentIntentId: 'pi_synthetic_deposit', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-20T16:05:00.000Z' }, { sessionId: 'cs_test_synthetic_tip', paymentIntentId: 'pi_synthetic_tip', amount: 50, purpose: 'tip', verifiedAt: '2026-09-21T16:05:00.000Z' }];
  const tipped = plan(job({ payment: { amount: 550, verified: true, stripeSessions: sessions }, invoice })).invoice;
  assert.deepEqual([tipped.paid, tipped.balance, tipped.status], [500, 650, 'partial']);
  // Unreadable payments leave the invoice without a paid figure, so money-core still asks for review.
  const unreadable = job({ payment: { verified: false }, deposit: { amount: 500, paidAmount: 'five hundred' }, invoice: { number: 'INV-TWO', status: 'issued', amount: 1000, balance: 1000 } }), patch = plan(unreadable);
  assert.deepEqual(patch.invoice, { ...unreadable.invoice, amount: 1150, balance: 1150, updatedAt: NOW });
  assert.ok(customerMoneyTotals({ ...unreadable, ...patch }).issues.includes('money_paid_invalid'));
});

test('a saved change total the decisions and lines do not explain is listed for the owner, never rewritten', async () => {
  // Approved for $150 before billing, then an old Hub write turned the answer back into a question: money-core still
  // bills the saved $150 while the portal asks the question again. No line is due, but the job is not current.
  const reverted = job({ customerDecisions: [answered({ status: 'pending', respondedAt: '', responseBy: '', responseSource: undefined })] });
  assert.deepEqual(customerMoneyTotals(reverted).issues, ['money_change_order_conflict']);
  const jobs = {
    reverted,
    unreadable: job({ approvedChangeTotal: 'lots' }),
    // A pre-billing approval whose saved total also counts a reverted answer is held rather than rewritten.
    held: job({ customerDecisions: [answered(), answered({ id: 'decision-paint', status: 'pending', respondedAt: '', responseBy: '', responseSource: undefined })], approvedChangeTotal: 190 }),
    // A total that matches, with a line or without one, is current or planned as before.
    matching: job(), 'no-total': job({ customerDecisions: [answered({ status: 'declined' })], approvedChangeTotal: undefined }),
  };
  const f = fixture(jobs), report = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.deepEqual(report.jobs.needsReview, [
    { id: 'held', issues: [{ decisionId: '', code: 'stored_total_mismatch', storedCents: 19000, derivedCents: 15000 }] },
    { id: 'reverted', issues: [{ decisionId: '', code: 'stored_total_mismatch', storedCents: 15000, derivedCents: 0 }] },
    { id: 'unreadable', issues: [{ decisionId: '', code: 'stored_total_mismatch', storedCents: null, derivedCents: 15000 }] },
  ]);
  assert.deepEqual([report.preview.map(row => row.id), report.jobs.current, report.writes.committed], [['matching'], 1, 1]);
  for (const id of ['held', 'reverted', 'unreadable']) assert.equal(f.job(id).revision, `${id}-r0`, `${id} is left for the owner`);
  // Once the customer answers, the portal recomputes the total and the job is current again.
  const answeredNow = { ...reverted, ...respondToDecision(reverted, { decisionId: 'decision-freezer', response: 'declined', respondedBy: 'Synthetic Customer', note: '', requestId: REQUEST, priceDeltaCents: null }, { billing: true, now: NOW }).patch };
  const after = planChangeOrderBackfill([{ ...answeredNow, id: 'reverted', revision: 'r' }], NOW);
  assert.deepEqual([after.writes, after.report.needsReview, after.report.current], [[], [], 1]);
});

test('no-show and declined jobs, and answers given after the approval window, are listed for review and never written', () => {
  const day = 86400000, jobs = [
    { ...job({ status: 'no_show' }), id: 'no-show', revision: 'r' }, { ...job({ pipelineStatus: 'noshow' }), id: 'noshow', revision: 'r' },
    { ...job({ status: 'no-show' }), id: 'no-show-dash', revision: 'r' }, { ...job({ pipelineStatus: 'declined' }), id: 'declined', revision: 'r' },
    { ...job({ customerDecisions: [answered({ respondedAt: new Date(Date.parse('2026-09-20T16:00:00.000Z') + 14 * day + 1000).toISOString() })] }), id: 'late-answer', revision: 'r' },
    { ...job({ customerDecisions: [answered({ respondedAt: new Date(Date.parse('2026-09-20T16:00:00.000Z') + 14 * day).toISOString() })] }), id: 'in-window', revision: 'r' },
    { ...job({ customerDecisions: [answered({ promptedAt: undefined })] }), id: 'unprompted', revision: 'r' },
  ];
  const { writes, report } = planChangeOrderBackfill(jobs, NOW);
  assert.deepEqual(report.needsReview.map(row => [row.id, row.issues.map(issue => issue.code)]), [
    ['declined', ['job_closed']], ['late-answer', ['answered_after_expiry']], ['no-show', ['job_closed']], ['no-show-dash', ['job_closed']], ['noshow', ['job_closed']],
  ]);
  assert.deepEqual(writes.map(row => row.id), ['in-window', 'unprompted'], 'an answer inside the window, or to a question without a send time, is backfilled');
});

test('--only and --exclude choose the jobs a run plans and report the rest', async () => {
  const f = fixture();
  const only = await runChangeOrderBackfill(f.store, { now: NOW, runId: RUN, only: ['open', 'typo-job'] });
  assert.deepEqual(only.preview.map(row => row.id), ['open']); assert.deepEqual(only.jobs.needsReview, []);
  assert.deepEqual([only.jobs.notSelected, only.jobs.unknownIds, only.jobs.skippedRecords], [13, ['typo-job'], 2]);
  const excluded = await runChangeOrderBackfill(f.store, { apply: true, now: NOW, runId: RUN, exclude: ['stripe-invoice', 'hub-invoice'] });
  assert.deepEqual(excluded.preview.map(row => row.id), ['open']); assert.deepEqual([excluded.writes.committed, excluded.jobs.notSelected, excluded.jobs.unknownIds], [1, 2, []]);
  assert.equal(f.job('stripe-invoice').revision, 'stripe-invoice-r0'); assert.equal(billedChangeCents(f.job('open')), 15000);
  // Without a selection the report keeps its shape.
  assert.equal('notSelected' in (await runChangeOrderBackfill(f.store, { now: NOW, runId: RUN })).jobs, false);
  for (const bad of [[], ['bad id'], ['_egc_schedule_lock_2026_09_22'], 'open']) assert.throws(() => planChangeOrderBackfill([], NOW, { only: bad }), { code: 'change_order_backfill_input_invalid' }, JSON.stringify(bad));
});

test('--apply needs --billing-enabled, because every saved line is billed whatever the flag says', () => {
  assert.deepEqual(parseArgs(['--apply', '--billing-enabled', '--include-finished', '--exclude', 'job-a, job-b']), { apply: true, report: '', help: false, billingEnabled: true, includeFinished: true, exclude: ['job-a', 'job-b'] });
  assert.deepEqual(parseArgs(['--only', 'job-c']), { apply: false, report: '', help: false, only: ['job-c'] });
  assert.match(applyRefusal(parseArgs(['--apply'])), /even while CHANGE_ORDER_BILLING_ENABLED is off.*--billing-enabled/);
  assert.equal(applyRefusal(parseArgs(['--apply', '--billing-enabled'])), '');
  assert.equal(applyRefusal(parseArgs([])), '', 'a dry run needs no confirmation');
  assert.throws(() => parseArgs(['--only', 'a', '--exclude', 'b']), /either --only or --exclude/);
  assert.throws(() => parseArgs(['--only', 'a', '--only', 'b']), /once/);
  assert.throws(() => parseArgs(['--only', 'bad id']), /comma-separated list of job ids/);
  assert.throws(() => parseArgs(['--only']), /Unknown or incomplete argument/);
  assert.throws(() => parseArgs(['--exclude', '--apply']), /Unknown or incomplete argument/);
});
