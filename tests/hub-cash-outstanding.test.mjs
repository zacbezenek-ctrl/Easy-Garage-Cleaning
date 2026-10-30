import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { payable } from '../functions/_lib/customer-payments.js';

// FIX-CASH-OUTSTANDING: the command center's "Cash outstanding" tile and the finance tiles count sold work only. A
// cancelled job (either spelling), a lost job and a quote still waiting for approval never count, and the tile shows
// what is owed now (the balance of finished or invoiced work plus the approved deposits still unpaid), with the rest
// of the booked work in its small line. Synthetic customers only; "today" is injected as a Denver date.
const TODAY = '2026-11-03';
const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const line = prefix => { const found = source.split(/\r?\n/).find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
const approved = (amount, deposit) => ({ estimate: { amount, depositRequired: deposit, status: 'accepted', acceptedAt: '2026-10-01T18:00:00.000Z' }, customerApproval: { status: 'approved', amount, approvedAt: '2026-10-01T18:00:00.000Z' } });
const paid = amount => ({ payment: { amount, verified: true, method: 'card', reference: 'SYN-RECEIPT' } });
const job = (id, status, fields) => ({ id, type: 'job', customer: `Synthetic ${id}`, status, pipelineStatus: status, ...fields });
const BOOK = [
  job('done-paid', 'completed', { completedAt: '2026-10-20T20:00:00.000Z', total: 1000, ...approved(1000, 250), ...paid(1000) }),
  // Finished, invoiced and past due: the $600 balance is owed now and overdue.
  job('done-overdue', 'invoiced', { completedAt: '2026-10-25T20:00:00.000Z', total: 800, ...approved(800, 200), ...paid(200),
    invoice: { number: 'INV-SYN-1', status: 'issued', amount: 800, issuedAt: '2026-10-25T21:00:00.000Z', dueDate: '2026-10-30' } }),
  // Approved with the deposit paid: the remainder is booked, due on the job day.
  job('deposit-paid', 'scheduled', { date: '2026-11-20', total: 2000, ...approved(2000, 500), ...paid(500) }),
  // Approved, deposit not paid yet: the $300 deposit is owed now, the $900 remainder later.
  job('deposit-due', 'scheduled', { date: '2026-11-12', total: 1200, ...approved(1200, 300) }),
  // Invoiced ahead of the job day: the invoice is not due until 11/14, and the deposit is paid.
  job('invoice-later', 'scheduled', { date: '2026-11-14', total: 1600, ...approved(1600, 400), ...paid(400),
    invoice: { number: 'INV-SYN-2', status: 'partial', amount: 1600, issuedAt: '2026-11-01T18:00:00.000Z', dueDate: '2026-11-14' } }),
  // Booked in the Hub without a quote: the portal takes nothing until the work is done.
  job('booked-no-quote', 'scheduled', { date: '2026-11-05', total: 950 }),
  // Approved, then revised and sent again with the deposit already paid: sold, but nothing more is due until re-approval.
  job('revised-paid', 'scheduled', { date: '2026-11-18', total: 1400, estimate: { amount: 1400, depositRequired: 350, status: 'sent' }, customerApproval: { status: 'superseded', amount: 1200 }, ...paid(300) }),
  // Finished with a billed change order: unified totals add it, the legacy board does not.
  job('change-done', 'completed', { completedAt: '2026-10-28T20:00:00.000Z', total: 1000, ...approved(1000, 250), ...paid(1000),
    customerDecisions: [{ id: 'dec-syn-1', status: 'approved', priceDelta: 150 }], approvedChangeTotal: 150,
    changeOrders: [{ id: 'change-dec-syn-1', kind: 'fee', source: 'customer_decision', decisionId: 'dec-syn-1', totalCents: 15000, name: 'Extra shelving' }] }),
  // A no-show is still sold work, but nothing on it is owed now (a rebooked visit is its own job).
  job('no-show', 'no_show', { date: '2026-11-01', total: 700, ...approved(700, 175) }),
  // Never counted: a quote not approved, a lost quote, and cancelled jobs in both spellings (one with an overdue invoice).
  job('sent-quote', 'estimate', { date: '2026-11-20', total: 5000, estimate: { amount: 5000, depositRequired: 1250, status: 'sent' } }),
  job('lost-quote', 'lost', { total: 2500, estimate: { amount: 2500, status: 'sent' } }),
  job('canceled-us', 'canceled', { total: 1000, ...approved(1000, 250), invoice: { number: 'INV-SYN-3', status: 'issued', amount: 1000, issuedAt: '2026-10-10T18:00:00.000Z', dueDate: '2026-10-20' } }),
  job('cancelled-uk', 'cancelled', { total: 900, ...approved(900, 225) }),
  { id: 'walk-syn', type: 'walkthrough', customer: 'Synthetic walkthrough', status: 'scheduled', date: TODAY, total: 400 },
];
const NEVER = ['sent-quote', 'lost-quote', 'canceled-us', 'cancelled-uk'];

// The Hub's money module and the suite's tile code, loaded as the page loads them, with the browser shell stubbed.
function hub(jobs, unified) {
  const store = new Map(unified ? [['egc.moneyTotals.unified', 'true']] : []);
  const context = vm.createContext({ window: { addEventListener() {} }, sessionStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) } });
  vm.runInContext(readFileSync(new URL('../employee-money-totals.js', import.meta.url), 'utf8'), context, { filename: 'employee-money-totals.js' });
  Object.assign(context, {
    S: { ghl: { opportunities: [], error: 'not-configured' }, peopleState: { loaded: true }, accountState: { loaded: true }, people: {} },
    jobs: () => jobs, jobStage: j => j.pipelineStatus || j.status || 'scheduled', day: () => TODAY, financeDatePlus: () => '2026-11-04',
    managerScheduleVerified: () => false, todayDelivery: () => [], todayWalkthroughs: () => [], flaggedToday: () => [], isOwnerAccount: () => false,
    correctionsOn: () => false, staleShifts: () => [], openJobs: () => [], crewNames: () => [], esc: String,
    jobEconomics: () => ({ known: false }), laborState: () => 'visible', laborNote: () => '', money: value => `$${Number(value || 0).toFixed(2)}`,
  });
  vm.runInContext([line('function financeState('), line('function metrics('), line('function attention('),
    source.slice(source.indexOf('function financeSummary(){'), source.indexOf('function cacheSalesExit('))].join('\n'), context);
  const html = context.metrics() + context.financeSummary();
  const tile = label => html.match(new RegExp(`<span>${label}</span><strong>([^<]+)</strong><small>([^<]*)</small>`))?.slice(1);
  return { context, api: context.window.EGCMoneyTotals, tile, attention: context.attention() };
}

test('Cash outstanding counts only what is owed now on sold work, with booked work due later in its small line', () => {
  for (const unified of [false, true]) {
    const { tile } = hub(BOOK, unified);
    // Owed now: $600 finished and invoiced + $300 approved deposit (+ the $150 billed change, unified only).
    // Due later: $1,500 + $900 + $1,200 + $950 + $1,100 of booked balances.
    const [owed, small] = tile('Cash outstanding');
    assert.equal(owed, unified ? '$1050.00' : '$900.00', `unified=${unified}`);
    assert.equal(small, '$600.00 overdue · $5650.00 booked, due later', `unified=${unified}`);
  }
});

test('the finance tiles leave out lost and unapproved quotes and cancelled jobs in either spelling', () => {
  for (const unified of [false, true]) {
    const { tile } = hub(BOOK, unified);
    // Sold: 1,000 + 800 + 2,000 + 1,200 + 1,600 + 950 + 1,400 + 1,000 (1,150 unified) + 700 no-show.
    assert.deepEqual(tile('Sold work'), [unified ? '$10800.00' : '$10650.00', '9 billable jobs'], `unified=${unified}`);
    // Verified toward that work: 1,000 + 200 + 500 + 400 + 300 + 1,000.
    assert.deepEqual(tile('Open / unverified'), [unified ? '$7400.00' : '$7250.00', 'Hub records, before accounting sync'], `unified=${unified}`);
    assert.equal(tile('Verified collected')[0], '$3400.00', `unified=${unified}`);
  }
});

test('nothing on a cancelled, lost or unapproved job is owed, overdue or in the attention queue', () => {
  for (const unified of [false, true]) {
    const { api, context, attention } = hub(BOOK, unified);
    for (const id of NEVER) {
      const row = BOOK.find(item => item.id === id);
      assert.equal(api.sold(row), false, `${id} is not sold work`);
      assert.equal(api.outstanding(row, context.financeState(row), TODAY), null, `${id} owes nothing`);
    }
    assert.equal(api.outstanding(BOOK.find(item => item.id === 'no-show'), context.financeState(BOOK.find(item => item.id === 'no-show')), TODAY), null, 'a no-show owes nothing now');
    assert.match(attention, /Synthetic done-overdue has \$600\.00 overdue/);
    assert.doesNotMatch(attention, /Synthetic canceled-us/, 'a cancelled job is never chased as overdue');
    // Only cancelled and lost jobs in the book: no money is outstanding at all.
    const cancelledOnly = hub(BOOK.filter(item => NEVER.includes(item.id)), unified);
    assert.deepEqual(cancelledOnly.tile('Cash outstanding'), ['$0.00', 'No overdue invoices']);
    assert.deepEqual(cancelledOnly.tile('Sold work'), ['$0.00', '0 billable jobs']);
  }
});

test('what the tile counts as owed now is what the customer portal would take today', () => {
  for (const [mode, unified] of [['off', false], ['unified', true]]) {
    const { api, context } = hub(BOOK, unified);
    // With the flag off the board's balance has never included billed change orders (the portal's does), so that one
    // job is compared in unified mode only, where both read money-core.
    for (const row of BOOK.filter(item => item.type === 'job' && !NEVER.includes(item.id) && item.id !== 'no-show' && (unified || item.id !== 'change-done'))) {
      const owed = api.outstanding(row, context.financeState(row), TODAY);
      let portal;
      try { portal = Math.round(payable(row, mode).dueNow * 100); } catch (error) { assert.match(error.message, /Approve the estimate before paying/, row.id); portal = 0; }
      assert.equal(owed.dueNowCents, portal, `${row.id}, mode=${mode}`);
      assert.equal(owed.dueNowCents + owed.laterCents, Math.round(context.financeState(row).balance * 100), `${row.id} splits its whole balance, mode=${mode}`);
    }
  }
});

test('an invoice counts its whole balance as owed from its due date', () => {
  const invoiced = BOOK.find(item => item.id === 'invoice-later');
  for (const unified of [false, true]) {
    const { api, context } = hub([invoiced], unified), finance = context.financeState(invoiced);
    assert.deepEqual({ ...api.outstanding(invoiced, finance, '2026-11-13') }, { dueNowCents: 0, laterCents: 120000 });
    assert.deepEqual({ ...api.outstanding(invoiced, finance, '2026-11-14') }, { dueNowCents: 120000, laterCents: 0 });
  }
});

test('the tiles keep working without the money module', () => {
  const context = vm.createContext({ window: {} });
  Object.assign(context, { S: { ghl: { opportunities: [], error: 'not-configured' } }, jobs: () => BOOK, jobStage: j => j.pipelineStatus || j.status || 'scheduled', day: () => TODAY,
    managerScheduleVerified: () => false, todayDelivery: () => [], todayWalkthroughs: () => [], money: value => `$${Number(value || 0).toFixed(2)}` });
  vm.runInContext([line('function financeState('), line('function metrics(')].join('\n'), context);
  assert.match(context.metrics(), /<span>Cash outstanding<\/span><strong>—<\/strong>/);
});
