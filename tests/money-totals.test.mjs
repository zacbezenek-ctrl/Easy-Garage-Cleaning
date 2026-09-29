import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { CHANGE_ORDER_UNBILLED, MONEY_TOTALS_MODES, customerMoneyTotals, invoiceFromEstimate, invoiceLineItems, invoiceStatus, moneyTotalsMode, moneyUnpriced, reportTotalsMismatch, servedMoneyTotals } from '../functions/_lib/money-core.js';
import { MONEY_REVIEW_TEXT, UNPRICED_TEXT, checkoutFingerprint, customerDepositState, customerMoneyState, payable } from '../functions/_lib/customer-payments.js';
import { expireStaleCheckout } from '../functions/_lib/quote-draft.js';
import { listMoney, moneyCsv } from '../functions/_lib/money-reports.js';
import { listInvoiceBatch } from '../functions/_lib/money-batch.js';
import { moneyDocumentKinds, moneyDocumentModel } from '../functions/_lib/money-document.js';
import { moneyProjection, mutateMoney } from '../functions/_lib/money-service.js';
import { moneyHandlers } from '../functions/api/money.js';
import { moneyDocumentHandlers } from '../functions/api/money-document.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import * as jobPayment from '../functions/api/job-payment.js';
import { applyWrite } from './helpers/commit-write.mjs';
import { portalCookie, portalHandlers, portalPost, portalView } from './helpers/portal-fixture.mjs';
import { NOW, OFF, ORIGIN, SHADOW, UNIFIED, moneyJobs, paymentWorld } from './helpers/money-totals-fixture.mjs';

// FIX-MONEY-TOTALS: with MONEY_UNIFIED_TOTALS=true one integer-cent total reaches every surface: the portal payload,
// the Stripe unit_amount the portal checkout sends, the /api/job-payment cap and closeout balance, money-core, the
// money documents, the Hub money view and the Hub board's pure module. Approved changes count only as billed lines.
const cents = dollars => Math.round(dollars * 100);
const FIXED = Date.parse(NOW);
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [FIXED])); } static now() { return FIXED; } }
const read = async response => ({ status: (await response).status, body: await (await response).clone().json() });
// What each fixture must show in unified mode, in cents: total, paid toward service, balance, due now, approved changes.
const EXPECTED = {
  'quote-only': { total: 100000, paid: 0, balance: 100000, dueNow: 50000, changes: 0, purpose: 'deposit' },
  'deposit-paid': { total: 100000, paid: 50000, balance: 50000, dueNow: 0, changes: 0, purpose: 'deposit' },
  'billed-change': { total: 115000, paid: 50000, balance: 65000, dueNow: 65000, changes: 15000, purpose: 'balance' },
  'unbilled-change': { total: 100000, paid: 50000, balance: 50000, dueNow: 50000, changes: 0, purpose: 'balance', unbilled: true },
  overpaid: { total: 100000, paid: 120000, balance: 0, dueNow: 0, changes: 0, purpose: 'balance' },
  'tip-present': { total: 100000, paid: 70000, balance: 30000, dueNow: 30000, changes: 0, purpose: 'balance', tips: 5000 },
  'business-job': { total: 100000, paid: 0, balance: 100000, dueNow: 100000, changes: 0, purpose: 'balance' },
};
// A tip recorded inside payment.amount by an older writer (a stripeSessions purpose:'tip' row): today's portal counts it
// as paid ($600 of $1,000), unified money never does ($500 applied, $500 owed).
const withLegacyTip = (jobs, id = 'legacy-tip') => ({ ...jobs, [id]: { ...jobs['deposit-paid'], id, status: 'completed', pipelineStatus: 'completed', completedAt: NOW,
  payment: { ...jobs['deposit-paid'].payment, amount: 600, stripeSessions: [...jobs['deposit-paid'].payment.stripeSessions, { sessionId: `cs_test_${id.replace(/-/g, '_')}`, paymentIntentId: `pi_${id.replace(/-/g, '_')}`, amount: 100, purpose: 'tip', verifiedAt: '2026-09-22T17:05:00.000Z' }] } } });
const hubCookie = async env => (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
const closeoutRead = async (env, id, cookie) => read(jobPayment.onRequestGet({ env, request: new Request(`${ORIGIN}/api/job-payment?job_id=${encodeURIComponent(id)}`, { headers: { Cookie: cookie, Origin: ORIGIN } }) }));
const cardProbe = async (env, id, cookie, amount) => read(jobPayment.onRequestPost({ env, request: new Request(`${ORIGIN}/api/job-payment`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: id, request_id: `cap-${id}-${amount}`, amount_cents: amount }) }) }));
const rows = doc => Object.fromEntries(doc.rows.map(row => [row.label, row.cents]));
// The Hub board's pure module, loaded as the page loads it.
function hubModule(sessionValue = null) {
  const store = new Map(sessionValue === null ? [] : [['egc.moneyTotals.unified', sessionValue]]), listeners = {};
  const context = vm.createContext({ window: { addEventListener: (type, handler) => { listeners[type] = handler; } }, sessionStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) }, Date: FixedDate });
  vm.runInContext(readFileSync(new URL('../employee-money-totals.js', import.meta.url), 'utf8'), context, { filename: 'employee-money-totals.js' });
  return { api: context.window.EGCMoneyTotals, store, listeners, context };
}

// Exercise the rendered finance tiles with both the legacy and unified totals.
// Credit lowers cash collected, but still settles the job and its open balance.
function financeTiles(job, unified) {
  const { context } = hubModule(unified ? 'true' : null);
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  const line = prefix => { const found = source.split(/\r?\n/).find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  Object.assign(context, { jobs: () => [job], jobStage: () => 'scheduled', day: () => '2026-09-29', jobEconomics: () => ({ known: false }), laborState: () => 'visible', money: value => `$${Number(value).toFixed(2)}` });
  // financeSummary is multiline, so take its complete body through the next function.
  vm.runInContext([line('function financeState('), source.slice(source.indexOf('function financeSummary(){'), source.indexOf('function cacheSalesExit('))].join('\n'), context);
  const html = context.financeSummary(), tile = label => html.match(new RegExp(`<span>${label}</span><strong>([^<]+)</strong>`))?.[1];
  return { cash: tile('Verified collected'), open: tile('Open / unverified'), balance: context.financeState(job).balance, html };
}

test('Hub collected tile excludes verified gift and account credit without reopening settled jobs', () => {
  const quote = { id: 'credit-job', type: 'job', total: 100, estimate: { amount: 100, status: 'accepted' } };
  const cases = [
    { name: 'credit only', payment: { amount: 100, verified: true, method: 'gift_credit', giftCreditApplied: 100 }, cash: '$0.00', open: '$0.00', balance: 0 },
    { name: 'mixed card and credit', payment: { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 50 }, cash: '$50.00', open: '$0.00', balance: 0 },
    { name: 'unverified cash', payment: { amount: 100, verified: false, method: 'card' }, cash: '$0.00', open: '$100.00', balance: 0 },
    { name: 'cash without credit', payment: { amount: 100, verified: true, method: 'card' }, cash: '$100.00', open: '$0.00', balance: 0 },
  ];
  for (const unified of [false, true]) for (const row of cases) {
    const result = financeTiles({ ...quote, payment: row.payment }, unified);
    assert.deepEqual([result.cash, result.open, result.balance], [row.cash, row.open, row.balance], `${row.name}, unified=${unified}`);
  }
});

test('Hub collected tile marks an unknown credit split for review, not as cash', () => {
  const quote = { id: 'credit-review', type: 'job', total: 100, estimate: { amount: 100, status: 'accepted' } };
  const cases = [
    { amount: 100, verified: true, method: 'gift_credit' },
    { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 'bad' },
    { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: true },
    { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: [50] },
    { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 120 },
  ];
  for (const unified of [false, true]) for (const payment of cases) {
    const result = financeTiles({ ...quote, payment }, unified);
    assert.equal(result.cash, '—');
    assert.equal(result.open, '$0.00');
    assert.match(result.html, /Payment or credit amount needs review/);
  }
  const conflict = financeTiles({ ...quote, payment: { amount: 100, verified: true, giftCreditApplied: 20 },
    giftWallet: { redemptions: [{ id: 'r1', jobId: quote.id, amount: 30 }] } }, true);
  assert.equal(conflict.cash, '—', 'a local redemption exceeding the authoritative aggregate cannot be treated as cash');
  for (const amount of [true, [10]]) {
    const malformed = financeTiles({ ...quote, payment: { amount: 100, verified: true, giftCreditApplied: 20 },
      giftWallet: { redemptions: [{ id: 'r1', jobId: quote.id, amount }] } }, true);
    assert.equal(malformed.cash, '—', 'malformed redemption amounts cannot look like known cash');
  }
});

test('Hub collected cash uses applied service money once: tips and corrected refunds are not double subtracted', () => {
  const quote = { id: 'credit-adjustments', type: 'job', total: 100, estimate: { amount: 100, status: 'accepted' } };
  const separateTip = { ...quote, payment: { amount: 100, verified: true, method: 'card', tips: [{ sessionId: 'cs_test_tip_service', amount: 10, amountCents: 1000 }] } };
  const withCredit = { ...quote, payment: { amount: 100, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 20 },
    giftWallet: { redemptions: [{ id: 'other-job-credit', jobId: 'another-job', amount: 90 }] } };
  for (const unified of [false, true]) {
    assert.equal(financeTiles(separateTip, unified).cash, '$100.00', `tip is excluded from service money, unified=${unified}`);
    assert.equal(financeTiles(withCredit, unified).cash, '$80.00', `account credit does not need a local redemption, unified=${unified}`);
    const corrected = financeTiles({ ...withCredit, payment: { ...withCredit.payment, amount: 60 }, paymentLedger: [{ id: 'refund-1', kind: 'refund', amountCents: 4000, method: 'card' }] }, unified);
    assert.deepEqual([corrected.cash, corrected.open, corrected.balance], ['$40.00', '$40.00', 40], `the corrected paid total already nets the refund, unified=${unified}`);
  }
  const reviewOnly = financeTiles({ ...withCredit, stripeReview: { status: 'refund_review' } }, true);
  assert.equal(reviewOnly.cash, '$80.00', 'a refund review alone does not alter the job payment');
  const legacyTip = { ...withCredit, payment: { ...withCredit.payment, amount: 110, stripeSessions: [{ sessionId: 'cs_live_old_tip', amount: 10, purpose: 'tip', verifiedAt: '2026-09-29T10:00:00Z' }] } };
  assert.equal(financeTiles(legacyTip, false).cash, '$90.00', 'flag-off treatment of an older tip inside payment.amount is preserved');
  assert.equal(financeTiles(legacyTip, true).cash, '$80.00', 'unified mode keeps its existing service-only applied amount');
});

test('moneyTotalsMode reads MONEY_UNIFIED_TOTALS: true is unified, shadow is shadow, anything else is off', () => {
  assert.deepEqual([...MONEY_TOTALS_MODES], ['off', 'shadow', 'unified']);
  for (const [value, mode] of [[undefined, 'off'], ['', 'off'], ['false', 'off'], ['TRUE', 'off'], ['yes', 'off'], ['1', 'off'], ['true', 'unified'], [' true ', 'unified'], ['shadow', 'shadow'], ['Shadow', 'off']]) {
    assert.equal(moneyTotalsMode(value === undefined ? {} : { MONEY_UNIFIED_TOTALS: value }), mode, String(value));
  }
  assert.equal(moneyTotalsMode(undefined), 'off');
});

test('every fixture agrees to the cent: portal payload, Stripe unit_amount, job-payment cap and closeout, money-core, documents, the Hub money view and board module', async t => {
  const hub = hubModule('true');
  for (const [id, expected] of Object.entries(EXPECTED)) {
    await t.test(id, async t => {
      const world = paymentWorld(t), handlers = portalHandlers(NOW), cookie = await portalCookie(id), staff = await hubCookie(UNIFIED);
      const job = { ...world.store.job(id), id }, core = customerMoneyTotals(job, { unified: true });
      // money-core, as expected.
      assert.deepEqual([core.totalCents, core.appliedCents, core.balanceCents, core.dueNowCents, core.approvedChangeCents, core.purpose], [expected.total, expected.paid, expected.balance, expected.dueNow, expected.changes, expected.purpose]);
      assert.equal(core.issues.includes(CHANGE_ORDER_UNBILLED), expected.unbilled === true);
      if (expected.tips) assert.equal(core.tipCents, expected.tips, 'the tip is recorded beside the service money, never in it');
      // The portal payload.
      const view = await portalView(handlers, cookie, UNIFIED), payment = view.body.payment;
      assert.equal(view.status, 200);
      assert.deepEqual([cents(payment.total), cents(payment.paid), cents(payment.balance), cents(payment.dueNow), cents(payment.approvedChanges), payment.purpose, payment.moneyReview], [core.totalCents, core.appliedCents, core.balanceCents, core.dueNowCents, core.approvedChangeCents, core.purpose, false]);
      assert.equal(payment.changes.reduce((sum, line) => sum + cents(line.amount), 0), core.approvedChangeCents, 'the listed changes add up to the approved changes');
      // The Stripe unit_amount of the portal checkout: exactly what is due now, or no checkout at all.
      const pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: `pay-${id}` }, UNIFIED), portalCheckout = world.created.filter(item => item.kind === 'egc_customer_portal_payment');
      if (core.dueNowCents >= 50) {
        assert.equal(pay.status, 200, JSON.stringify(pay.body));
        assert.deepEqual(portalCheckout.map(item => item.unitAmount), [core.dueNowCents]);
        assert.equal(cents(pay.body.amount), core.dueNowCents);
        assert.equal(portalCheckout[0].params.get('metadata[quoted_total_cents]'), String(core.totalCents));
      } else { assert.equal(pay.status, 409); assert.deepEqual(portalCheckout, []); }
      // The closeout balance and the job-payment cap.
      const closeout = await closeoutRead(UNIFIED, id, staff);
      assert.deepEqual([closeout.status, closeout.body.unified, closeout.body.balance], [200, true, { totalCents: core.totalCents, paidCents: core.appliedCents, balanceCents: core.balanceCents, approvedChangeCents: core.approvedChangeCents }]);
      assert.equal(closeout.body.issues.includes(CHANGE_ORDER_UNBILLED), expected.unbilled === true);
      const over = await cardProbe(UNIFIED, id, staff, Math.max(50, core.balanceCents + 1));
      assert.deepEqual([over.status, over.body.error], [409, 'Payment exceeds the current job balance']);
      if (core.balanceCents >= 50) {
        const exact = await cardProbe(UNIFIED, id, staff, core.balanceCents);
        assert.equal(exact.status, 200, JSON.stringify(exact.body));
        assert.deepEqual(world.created.filter(item => item.kind === 'egc_job_payment').map(item => item.unitAmount), [core.balanceCents]);
      }
      // The money documents (invoice and estimate) and their Pay button.
      const invoice = moneyDocumentModel(job, { kind: 'invoice', now: NOW, unified: true, payUrl: '/customer-portal#pay' });
      assert.deepEqual([rows(invoice).Total, rows(invoice)['Payments received'], rows(invoice)['Balance due']], [core.totalCents, core.appliedCents, core.balanceCents]);
      assert.equal(invoice.lines.reduce((sum, line) => sum + line.totalCents, 0), core.totalCents, 'the invoice lines add up to the unified total');
      assert.equal(invoice.pay?.amountCents ?? 0, core.dueNowCents >= 50 ? core.dueNowCents : 0, 'the document offers Pay for exactly what the checkout charges');
      const estimate = moneyDocumentModel(job, { kind: 'estimate', now: NOW, unified: true });
      assert.equal(rows(estimate).Total, core.totalCents);
      assert.equal(rows(estimate)['Approved changes'] ?? 0, core.approvedChangeCents);
      // The Hub money view (/api/money job view) and the Hub board's pure module.
      const projected = moneyProjection(job, NOW, { unified: true }).totals;
      assert.deepEqual([projected.totalCents, projected.appliedCents, projected.balanceCents, projected.dueNowCents, projected.approvedChangeCents], [core.totalCents, core.appliedCents, core.balanceCents, core.dueNowCents, core.approvedChangeCents]);
      const board = hub.api.totals(job);
      for (const key of ['quoteCents', 'approvedChangeCents', 'totalCents', 'paidCents', 'tipCents', 'appliedCents', 'balanceCents', 'overpaidCents', 'depositRequiredCents', 'depositPaidCents', 'depositDueCents', 'dueNowCents', 'purpose', 'remainderCents']) assert.equal(board[key], core[key], `${id} ${key}`);
      assert.equal(board.issues.includes(CHANGE_ORDER_UNBILLED), expected.unbilled === true);
    });
  }
});

test('an approval with no billed line is left out and flagged; the unified money never counts it, while today\'s money-core still does', () => {
  const job = { ...moneyJobs()['unbilled-change'] }, before = customerMoneyTotals(job), unified = customerMoneyTotals(job, { unified: true });
  assert.deepEqual([before.approvedChangeCents, before.totalCents, before.balanceCents], [15000, 115000, 65000], 'today money-core counts the saved approvedChangeTotal');
  assert.deepEqual([unified.approvedChangeCents, unified.totalCents, unified.balanceCents, unified.unified], [0, 100000, 50000, true]);
  assert.deepEqual(unified.issues, [CHANGE_ORDER_UNBILLED]);
  assert.deepEqual(customerMoneyState(job), { total: 1000, paid: 500, balance: 500 }, 'the portal never counted it either');
  // An approval shown at a price that cannot be read is flagged too, a $0 answer and a voided line are not.
  const base = { ...job, approvedChangeTotal: undefined };
  const decision = patch => ({ ...base, customerDecisions: [{ ...job.customerDecisions[0], ...patch }] });
  assert.deepEqual(customerMoneyTotals(decision({ priceDelta: 'lots' }), { unified: true }).issues, [CHANGE_ORDER_UNBILLED]);
  assert.deepEqual(customerMoneyTotals(decision({ priceDelta: 2000000 }), { unified: true }).issues, [CHANGE_ORDER_UNBILLED]);
  for (const quiet of [decision({ priceDelta: 0 }), decision({ priceDelta: '' }), decision({ status: 'declined' }), decision({ changeOrderVoidedAt: NOW })]) assert.deepEqual(customerMoneyTotals(quiet, { unified: true }).issues, [], JSON.stringify(quiet.customerDecisions));
  // A saved total above the billed lines (an approval a stale write dropped) is flagged; the lines still decide the money.
  const billed = moneyJobs()['billed-change'];
  assert.deepEqual(customerMoneyTotals(billed, { unified: true }).issues, []);
  const raised = customerMoneyTotals({ ...billed, approvedChangeTotal: 225 }, { unified: true });
  assert.deepEqual([raised.approvedChangeCents, raised.issues], [15000, [CHANGE_ORDER_UNBILLED]]);
  assert.deepEqual(customerMoneyTotals({ ...billed, approvedChangeTotal: 100 }, { unified: true }).issues, [], 'a lower saved total never lowers the billed lines');
  const voided = { ...billed, changeOrders: billed.changeOrders.map(line => ({ ...line, status: 'void', voidedAt: NOW })), approvedChangeTotal: 0 };
  assert.deepEqual([customerMoneyTotals(voided, { unified: true }).approvedChangeCents, customerMoneyTotals(voided, { unified: true }).issues], [0, []]);
  // Invoices built from unified money bill only the billed lines, and read their status from it.
  const issued = invoiceFromEstimate(job, { now: NOW, unified: true }).invoice;
  assert.deepEqual([issued.amountCents, issued.approvedChangeCents, issued.balanceCents], [100000, 0, 50000]);
  assert.deepEqual(issued.lineItems.map(line => [line.id, line.totalCents]), [['reset', 100000]]);
  assert.deepEqual(invoiceFromEstimate(job, { now: NOW }).invoice.lineItems.map(line => [line.id, line.totalCents]), [['reset', 100000], ['change-decision-freezer', 15000]], 'unchanged without the flag');
  assert.deepEqual(invoiceLineItems(billed, customerMoneyTotals(billed, { unified: true })).lineItems.map(line => [line.id, line.totalCents]), [['reset', 100000], ['change-decision-freezer', 15000]]);
  const paidInvoice = { ...job, payment: { ...job.payment, amount: 1000 }, invoice: { ...issued, status: 'issued' } };
  assert.deepEqual([invoiceStatus(paidInvoice, NOW), invoiceStatus(paidInvoice, NOW, { unified: true })], ['partial', 'paid'], 'what the unbilled approval kept open is paid in unified money');
});

test('shadow mode serves today\'s numbers everywhere and logs money_totals_mismatch once with the job id and both cent values', async t => {
  const logged = [], warn = t.mock.method(console, 'warn', line => { logged.push(line); });
  const jobs = withLegacyTip(moneyJobs());
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW);
  for (const id of Object.keys(jobs)) {
    const cookie = await portalCookie(id), off = await portalView(handlers, cookie, OFF), before = logged.length, shadow = await portalView(handlers, cookie, SHADOW);
    assert.deepEqual(shadow.body, off.body, `${id}: shadow serves exactly today's payload`);
    assert.equal(off.body.payment.changes, undefined, 'the unified change list is not added while the flag is off');
    assert.equal(logged.length - before, id === 'legacy-tip' ? 1 : 0, `${id}: a mismatch is logged once per read, and only when the figures differ`);
  }
  const line = logged.at(-1);
  assert.match(line, /^money_totals_mismatch /);
  assert.deepEqual(JSON.parse(line.replace(/^money_totals_mismatch /, '')), { jobId: 'legacy-tip', surface: 'portal', served: { totalCents: 100000, paidCents: 60000, balanceCents: 40000, dueNowCents: 40000 }, unified: { totalCents: 100000, paidCents: 50000, balanceCents: 50000, dueNowCents: 50000 } });
  assert.doesNotMatch(logged.join('\n'), /Synthetic Customer|example\.invalid|970-555/, 'the log carries no customer data');
  // Unified serves the unified figures for the same job.
  const unified = (await portalView(handlers, await portalCookie('legacy-tip'), UNIFIED)).body.payment;
  assert.deepEqual([unified.paid, unified.balance, unified.dueNow], [500, 500, 500]);
  // The checkout and the job-payment cap charge today's figures in shadow mode, logging once each.
  logged.length = 0;
  const pay = await portalPost(handlers, await portalCookie('legacy-tip'), { action: 'create_payment', request_id: 'pay-legacy-tip-shadow' }, SHADOW);
  assert.equal(pay.status, 200); assert.deepEqual(world.created.map(item => item.unitAmount), [40000]);
  assert.deepEqual(logged.map(item => JSON.parse(item.replace(/^money_totals_mismatch /, '')).surface), ['checkout']);
  const staff = await hubCookie(SHADOW);
  assert.equal((await cardProbe(SHADOW, 'legacy-tip', staff, 40001)).status, 409);
  assert.equal((await cardProbe(SHADOW, 'legacy-tip', staff, 40000)).status, 200);
  assert.deepEqual((await closeoutRead(SHADOW, 'legacy-tip', staff)).body, { ok: true, jobId: 'legacy-tip', unified: false });
  assert.deepEqual(logged.map(item => JSON.parse(item.replace(/^money_totals_mismatch /, '')).surface), ['checkout', 'job_payment', 'job_payment', 'closeout']);
  // money-core surfaces: the documents and the Hub money view keep today's money-core figures ($1,150 with the unbilled approval).
  logged.length = 0;
  const staffDocs = moneyDocumentHandlers({ now: () => new Date(NOW) }), docRequest = env => staffDocs.get({ env, request: new Request(`${ORIGIN}/api/money-document?kind=invoice&job_id=unbilled-change`, { headers: { Cookie: staff, Origin: ORIGIN } }) });
  const [offDoc, shadowDoc, unifiedDoc] = [await (await docRequest(OFF)).text(), await (await docRequest(SHADOW)).text(), await (await docRequest(UNIFIED)).text()];
  assert.equal(shadowDoc, offDoc, 'shadow renders today\'s document');
  assert.match(offDoc, /Balance due<\/span><strong>\$650\.00/); assert.match(unifiedDoc, /Balance due<\/span><strong>\$500\.00/);
  assert.doesNotMatch(unifiedDoc, /Approved change: Haul the old freezer/, 'an unbilled approval is not an invoice line in unified money');
  assert.deepEqual(logged.map(item => JSON.parse(item.replace(/^money_totals_mismatch /, ''))), [{ jobId: 'unbilled-change', surface: 'money_document', served: { totalCents: 115000, paidCents: 50000, balanceCents: 65000, dueNowCents: 65000 }, unified: { totalCents: 100000, paidCents: 50000, balanceCents: 50000, dueNowCents: 50000 } }]);
  logged.length = 0;
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  const moneyView = async mode => (await moneyHandlers({ session: async () => owner, storage: () => ({ totalsMode: mode, paymentEvents: false, read: async (collection, id) => collection === 'jobs' ? { ...world.store.job(id), id, revision: 'r1' } : null }), now: () => new Date(NOW) }).get({ env: {}, request: new Request(`${ORIGIN}/api/money?jobId=unbilled-change`, { headers: { 'Sec-Fetch-Site': 'same-origin' } }) })).json();
  const [offView, shadowView, unifiedView] = [await moneyView('off'), await moneyView('shadow'), await moneyView('unified')];
  assert.deepEqual(shadowView.job.totals, offView.job.totals);
  assert.deepEqual([offView.job.totals.totalCents, unifiedView.job.totals.totalCents, unifiedView.job.totals.issues], [115000, 100000, [CHANGE_ORDER_UNBILLED]]);
  assert.deepEqual(logged.map(item => JSON.parse(item.replace(/^money_totals_mismatch /, '')).surface), ['money_api']);
  assert.ok(warn.mock.callCount() > 0);
});

test('reportTotalsMismatch and servedMoneyTotals: nothing is logged when the figures agree, and a logging failure never changes money', () => {
  const lines = [];
  assert.equal(reportTotalsMismatch('job-1', 'portal', { totalCents: 1, paidCents: 0, balanceCents: 1, dueNowCents: 1 }, { totalCents: 1, paidCents: 0, balanceCents: 1, dueNowCents: 1 }, line => lines.push(line)), false);
  assert.equal(reportTotalsMismatch('job-1', 'portal', { totalCents: 1 }, { totalCents: null }, line => lines.push(line)), true);
  assert.deepEqual(JSON.parse(lines[0].split(' ').slice(1).join(' ')).unified, { totalCents: null, paidCents: null, balanceCents: null, dueNowCents: null });
  assert.equal(reportTotalsMismatch('job-1', 'portal', { totalCents: 1 }, { totalCents: 2 }, () => { throw new Error('log down'); }), true);
  const job = moneyJobs()['unbilled-change'], seen = [];
  assert.equal(servedMoneyTotals(job, 'off', { log: line => seen.push(line) }).totalCents, 115000);
  assert.equal(servedMoneyTotals(job, 'shadow', { surface: 'test', log: line => seen.push(line) }).totalCents, 115000);
  assert.equal(servedMoneyTotals(job, 'unified', { log: line => seen.push(line) }).totalCents, 100000);
  assert.equal(seen.length, 1); assert.match(seen[0], /"surface":"test"/);
});

test('flag off keeps today\'s figures on every surface, including an approval without a billed line', async t => {
  const world = paymentWorld(t), handlers = portalHandlers(NOW), staff = await hubCookie(OFF);
  const job = { ...world.store.job('unbilled-change'), id: 'unbilled-change' };
  assert.deepEqual(customerMoneyState(job), customerMoneyState(job, 'off'));
  assert.deepEqual(customerDepositState(job), customerDepositState(job, undefined, 'off'));
  const view = (await portalView(handlers, await portalCookie('unbilled-change'), OFF)).body.payment;
  assert.deepEqual([view.total, view.balance, view.dueNow, 'changes' in view, 'moneyReview' in view], [1000, 500, 500, false, false]);
  assert.deepEqual((await closeoutRead(OFF, 'unbilled-change', staff)).body, { ok: true, jobId: 'unbilled-change', unified: false });
  const reads = world.store.calls.length;
  assert.deepEqual((await closeoutRead(OFF, 'missing-job', staff)).body, { ok: true, jobId: 'missing-job', unified: false }, 'flag off answers without reading the job');
  assert.equal(world.store.calls.length, reads, 'no Firestore read while the flag is off');
  assert.equal(moneyDocumentModel(job, { kind: 'invoice', now: NOW }).totals.totalCents, 115000, 'documents keep today\'s money-core total');
  assert.equal(moneyProjection(job, NOW).totals.totalCents, 115000);
});

test('money that cannot be read is never charged in unified mode: the portal asks for a review, the checkout and the card cap refuse', async t => {
  const jobs = { 'text-quote': { ...moneyJobs()['quote-only'], id: 'text-quote', total: '1,000', priceQuoted: '1,000', estimate: { ...moneyJobs()['quote-only'].estimate, amount: '1,000' } } };
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW), cookie = await portalCookie('text-quote'), staff = await hubCookie(UNIFIED), job = { ...world.store.job('text-quote'), id: 'text-quote' };
  assert.equal(customerMoneyTotals(job, { unified: true }).totalCents, null);
  assert.deepEqual(customerMoneyState(job, 'unified'), { total: 1000, paid: 0, balance: 1000, unknown: true }, 'today\'s figures are shown, marked unknown');
  assert.equal(customerDepositState(job, undefined, 'unified').dueNow, 0);
  assert.throws(() => payable(job, 'unified'), { status: 409, code: 'CUSTOMER_PORTAL_MONEY_REVIEW', message: MONEY_REVIEW_TEXT });
  assert.equal(payable(job).dueNow, 500, 'today the lenient reader charges it');
  const view = (await portalView(handlers, cookie, UNIFIED)).body.payment;
  assert.deepEqual([view.moneyReview, view.dueNow, view.total, 'unknown' in view.deposit], [true, 0, 1000, false]);
  const pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-text-quote' }, UNIFIED);
  assert.deepEqual([pay.status, pay.body.error], [409, MONEY_REVIEW_TEXT]); assert.deepEqual(world.created, []);
  const card = await cardProbe(UNIFIED, 'text-quote', staff, 5000);
  assert.deepEqual([card.status, card.body.code], [409, 'JOB_PAYMENT_MONEY_REVIEW']);
  assert.deepEqual((await closeoutRead(UNIFIED, 'text-quote', staff)).body.balance, null);
  const credit = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'g1', amount: 10, request_id: 'credit-text-quote' }, UNIFIED);
  assert.deepEqual([credit.status, credit.body.code], [409, 'CUSTOMER_PORTAL_MONEY_REVIEW']);
  assert.deepEqual(moneyDocumentKinds(job, NOW, { unified: true }), [], 'no document shows money it cannot read');
});

// A job with no quote saved yet (a scheduled job before its estimate), open and completed.
const unpricedJobs = () => {
  const { estimate: _estimate, total: _total, priceQuoted: _priced, customerApproval: _approval, ...job } = moneyJobs()['quote-only'];
  return { unpriced: { ...job, id: 'unpriced', quoteStatus: '', giftWallet: { cards: [{ id: 'gift-1', label: 'Synthetic gift card', issuedAmount: 50, remainingAmount: 50 }] } },
    'unpriced-done': { ...job, id: 'unpriced-done', quoteStatus: '', status: 'completed', pipelineStatus: 'completed', completedAt: NOW } };
};

test('a job with no quote saved yet is shown as today in unified mode, never as money to review, and is never charged', async t => {
  const world = paymentWorld(t, unpricedJobs()), handlers = portalHandlers(NOW), staff = await hubCookie(UNIFIED);
  for (const id of ['unpriced', 'unpriced-done']) {
    const job = { ...world.store.job(id), id }, core = customerMoneyTotals(job, { unified: true });
    assert.deepEqual([core.issues, moneyUnpriced(core), core.totalCents], [['money_quote_missing'], true, null]);
    assert.deepEqual(customerMoneyState(job, 'unified'), { ...customerMoneyState(job), unknown: true, unpriced: true });
    const view = (await portalView(handlers, await portalCookie(id), UNIFIED)).body.payment, today = (await portalView(handlers, await portalCookie(id), OFF)).body.payment;
    assert.deepEqual([view.moneyReview, view.total, view.balance, view.dueNow, view.status], [false, today.total, today.balance, 0, today.status], `${id}: today's figures, no review`);
    assert.equal('unpriced' in view.deposit || 'unknown' in view.deposit, false);
    assert.deepEqual((await cardProbe(UNIFIED, id, staff, 5000)).body.code, 'JOB_PAYMENT_MONEY_REVIEW', 'the crew still cannot charge it');
  }
  const done = { ...world.store.job('unpriced-done'), id: 'unpriced-done' };
  assert.throws(() => payable(done, 'unified'), { status: 409, code: 'CUSTOMER_PORTAL_ESTIMATE_NOT_READY', message: UNPRICED_TEXT });
  const pay = await portalPost(handlers, await portalCookie('unpriced-done'), { action: 'create_payment', request_id: 'pay-unpriced-done' }, UNIFIED);
  assert.deepEqual([pay.status, pay.body.error], [409, UNPRICED_TEXT]); assert.deepEqual(world.created, []);
  const credit = await portalPost(handlers, await portalCookie('unpriced'), { action: 'apply_gift_credit', card_id: 'gift-1', amount: 10, request_id: 'credit-unpriced' }, UNIFIED);
  assert.deepEqual([credit.status, credit.body.code, credit.body.error], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_READY', UNPRICED_TEXT]);
  // Saved money that cannot be read on the same job is still the team's to review.
  const unreadable = { ...done, payment: { amount: 'lots', verified: true } };
  assert.equal(moneyUnpriced(customerMoneyTotals(unreadable, { unified: true })), false);
  assert.throws(() => payable(unreadable, 'unified'), { code: 'CUSTOMER_PORTAL_MONEY_REVIEW', message: MONEY_REVIEW_TEXT });
});

test('automatic HighLevel milestones and notes keep today\'s figures while the board shows unified money', () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), lines = suite.split(/\r?\n/), line = prefix => { const found = lines.find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const { api, context } = hubModule('true'), synced = [];
  // Paid $1,000 on a $1,000 invoice, $100 of it an older tip: today's board owes nothing, unified money owes $100, past due.
  const jobs = withLegacyTip(moneyJobs()), tipped = { ...jobs['legacy-tip'], customerAutomationEnabled: true, notify: true, payment: { ...jobs['legacy-tip'].payment, amount: 1000 },
    invoice: { number: 'INV-TIP-1', status: 'issued', amount: 1000, paid: 900, balance: 100, dueDate: '2026-09-01', issuedAt: '2026-08-25T17:00:00.000Z' } };
  Object.assign(context, { jobs: () => [tipped], isoDate: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    customerCommunicationTypes: { 'invoice-overdue': { label: 'Invoice overdue' }, 'invoice-sent': { label: 'Invoice sent' } }, syncCustomerCommunication: async (...args) => { synced.push(args.slice(1)); } });
  vm.runInContext([line('const payMoney='), line('const day='), line('function financeState('), line('function communicationNote('), line('async function runCustomerCommunicationMilestones('), line('function financeDatePlus(')].join('\n'), context);
  assert.equal(api.enabled(), true);
  assert.deepEqual([context.financeState(tipped).balance, context.financeState(tipped).invoice], [100, 'overdue'], 'the board shows the unified $100 overdue');
  assert.deepEqual([context.financeState(tipped, true).balance, context.financeState(tipped, true).invoice], [0, 'issued']);
  return context.runCustomerCommunicationMilestones().then(() => {
    assert.deepEqual(synced, [], 'no automatic overdue send that today would not make');
    assert.equal(context.communicationNote(tipped, 'invoice-sent'), 'Invoice sent · EST-PAID · Service date 2026-09-22 · Balance $0.00', 'the HighLevel note quotes today\'s balance');
    // A job today's board also calls overdue still gets its automatic milestone, exactly as before.
    context.jobs = () => [{ ...tipped, payment: { ...tipped.payment, amount: 600 } }];
    return context.runCustomerCommunicationMilestones();
  }).then(() => assert.deepEqual(synced, [['invoice-overdue', '2026-09-01']]));
});

test('a quote revision measures the open portal checkout in the mode it was opened in', async () => {
  const job = { ...withLegacyTip(moneyJobs())['legacy-tip'], id: 'legacy-tip' }, rows = new Map(), calls = [];
  const store = { read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) ?? null), commit: async writes => { for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...write.patch }); } };
  const stripe = async path => { calls.push(path); return { status: 'expired' }; };
  assert.notEqual(checkoutFingerprint(job, 0, 'unified'), checkoutFingerprint(job), 'the legacy tip makes the two modes charge different amounts');
  rows.set('customer_payment_checkouts/legacy-tip', { id: 'legacy-tip', revision: 'k1', status: 'open', sessionId: 'cs_test_unified_open', fingerprint: checkoutFingerprint(job, 0, 'unified') });
  assert.deepEqual(await expireStaleCheckout({ store, job, stripe, now: NOW, mode: 'unified' }), { status: 'current' }, 'a unified checkout for the same terms stays open');
  assert.deepEqual(calls, []);
  assert.deepEqual(await expireStaleCheckout({ store, job: { ...job, estimate: { ...job.estimate, amount: 1100, revision: 2 } }, stripe, now: NOW, mode: 'unified' }), { status: 'expired' });
  assert.deepEqual(calls, ['checkout/sessions/cs_test_unified_open/expire']);
  // Mode off (today) keeps comparing today's fingerprint.
  rows.set('customer_payment_checkouts/legacy-tip', { id: 'legacy-tip', revision: 'k2', status: 'open', sessionId: 'cs_test_off_open', fingerprint: checkoutFingerprint(job) });
  assert.deepEqual(await expireStaleCheckout({ store, job, stripe, now: NOW }), { status: 'current' });
});

test('shadow logs also cover payment records, gift credit, invoice lists and the invoice batch', async t => {
  const logged = [];
  t.mock.method(console, 'warn', line => { logged.push(line); });
  const surfaces = () => logged.splice(0).map(item => JSON.parse(item.replace(/^money_totals_mismatch /, '')).surface);
  const jobs = withLegacyTip(moneyJobs());
  jobs['legacy-tip'].giftWallet = { cards: [{ id: 'gift-1', label: 'Synthetic gift card', issuedAmount: 50, remainingAmount: 50 }] };
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW), cookie = await portalCookie('legacy-tip');
  const credit = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'gift-1', amount: 50, request_id: 'credit-legacy-tip-shadow' }, SHADOW);
  assert.deepEqual([credit.status, credit.body.applied, world.store.job('legacy-tip').payment.amount], [200, 50, 650], 'shadow applies credit exactly as today');
  const pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-legacy-tip-shadow-2' }, SHADOW), session = world.created.at(-1);
  assert.deepEqual([pay.status, session.unitAmount], [200, 35000]);
  world.complete(session.id, { paymentIntentId: 'pi_legacy_tip_shadow_paid', chargeId: 'ch_legacy_tip_shadow', receiptUrl: 'https://pay.stripe.com/receipts/legacy-tip-shadow' });
  assert.equal((await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session.id }, SHADOW)).status, 200);
  assert.deepEqual(surfaces(), ['gift_credit', 'checkout', 'payment_record']);
  const invoiced = { ...moneyJobs()['unbilled-change'], invoice: { number: 'INV-SHADOW-1', status: 'issued', amount: 1150, dueDate: '2026-09-29', issuedAt: '2026-09-22T17:00:00.000Z' } };
  const store = { totalsMode: 'shadow', paymentEvents: false, jobs: async () => [{ ...invoiced, revision: 'r1' }, { ...moneyJobs()['quote-only'], revision: 'r1' }] };
  const list = await listMoney(store, { view: 'invoices' }, NOW);
  assert.equal(list.rows.length, 1);
  assert.deepEqual(surfaces(), ['invoice_list']);
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  await listInvoiceBatch({ ...store, jobs: async () => [{ ...moneyJobs()['unbilled-change'], revision: 'r1' }, { ...moneyJobs()['quote-only'], revision: 'r1' }] }, owner, NOW);
  assert.deepEqual(surfaces(), ['invoice_batch'], 'only the job whose figures differ is logged');
  // Unified and off never log.
  assert.equal((await listMoney({ ...store, totalsMode: 'off' }, { view: 'invoices' }, NOW)).rows.length, 1);
  assert.equal((await listMoney({ ...store, totalsMode: 'unified' }, { view: 'invoices' }, NOW)).rows.length, 1);
  assert.deepEqual(surfaces(), []);
});

test('a paid unified checkout keeps payment.amount as the recorded total and answers the unified remaining balance', async t => {
  const jobs = withLegacyTip(moneyJobs());
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW);
  for (const [id, due, recorded, applied] of [['billed-change', 65000, 1150, 1150], ['legacy-tip', 50000, 1100, 1000]]) {
    const cookie = await portalCookie(id), pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: `pay-${id}` }, UNIFIED);
    const session = world.created.at(-1);
    assert.deepEqual([pay.status, session.unitAmount], [200, due]);
    world.complete(session.id, { paymentIntentId: `pi_${id.replace(/-/g, '_')}_paid`, chargeId: `ch_${id.replace(/-/g, '_')}`, receiptUrl: `https://pay.stripe.com/receipts/${id}` });
    const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session.id }, UNIFIED);
    assert.deepEqual([verified.status, verified.body.paid, verified.body.amountPaid, verified.body.balance], [200, true, due / 100, 0], id);
    const saved = world.store.job(id);
    assert.equal(saved.payment.amount, recorded, `${id}: every recorded dollar stays in payment.amount`);
    assert.deepEqual([saved.invoice.amount, saved.invoice.paid, saved.invoice.balance, saved.invoice.status], [applied, applied, 0, 'paid'], `${id}: the invoice mirror shows unified money`);
    const after = (await portalView(handlers, cookie, UNIFIED)).body.payment;
    assert.deepEqual([after.balance, after.dueNow, after.status], [0, 0, 'paid']);
  }
});

test('gift credit in unified mode keeps every recorded dollar: an older tip inside payment.amount never eats the credit', async t => {
  const wallet = { cards: [{ id: 'gift-1', label: 'Synthetic gift card', issuedAmount: 800, remainingAmount: 800, creditClass: 'gift_card' }] };
  const both = withLegacyTip(withLegacyTip(moneyJobs()), 'legacy-tip-off'), jobs = { 'legacy-tip': { ...both['legacy-tip'], giftWallet: wallet }, 'legacy-tip-off': { ...both['legacy-tip-off'], giftWallet: structuredClone(wallet) } };
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW), cookie = await portalCookie('legacy-tip');
  const before = (await portalView(handlers, cookie, UNIFIED)).body.payment;
  assert.deepEqual([before.paid, before.balance], [500, 500]);
  const credit = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'gift-1', amount: 800, request_id: 'credit-legacy-tip' }, UNIFIED);
  assert.deepEqual([credit.status, credit.body.applied, credit.body.balance], [200, 500, 0], JSON.stringify(credit.body));
  const saved = world.store.job('legacy-tip');
  assert.deepEqual([saved.payment.amount, saved.payment.giftCreditApplied, saved.giftWallet.cards[0].remainingAmount], [1100, 500, 300], 'the $100 tip stays recorded beside the $500 credit');
  const core = customerMoneyTotals({ ...saved, id: 'legacy-tip' }, { unified: true });
  assert.deepEqual([core.totalCents, core.appliedCents, core.tipCents, core.balanceCents], [100000, 100000, 10000, 0]);
  assert.deepEqual([cents(saved.invoice.amount), cents(saved.invoice.paid), cents(saved.invoice.balance), saved.invoice.status], [core.totalCents, core.appliedCents, core.balanceCents, 'paid'], 'the invoice mirror is money-core\'s unified money');
  const after = (await portalView(handlers, cookie, UNIFIED)).body.payment;
  assert.deepEqual([after.paid, after.balance, after.dueNow, after.status, after.creditApplied], [1000, 0, 0, 'paid', 500]);
  const replay = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'gift-1', amount: 800, request_id: 'credit-legacy-tip' }, UNIFIED);
  assert.deepEqual([replay.status, replay.body.ok, replay.body.balance], [409, false, undefined], 'nothing is left to apply credit to');
  assert.equal(world.store.job('legacy-tip').payment.amount, 1100);
  // Flag off is today's write: the credit is capped at today's $400 balance and payment.amount at today's total.
  const off = await portalPost(handlers, await portalCookie('legacy-tip-off'), { action: 'apply_gift_credit', card_id: 'gift-1', amount: 800, request_id: 'credit-legacy-tip-off' }, OFF);
  assert.deepEqual([off.status, off.body.applied, off.body.balance], [200, 400, 0]);
  const offSaved = world.store.job('legacy-tip-off');
  assert.deepEqual([offSaved.payment.amount, offSaved.invoice.amount, offSaved.invoice.paid, offSaved.invoice.balance, offSaved.invoice.status], [1000, 1000, 1000, 0, 'paid']);
});

test('the portal lists each billed change as its own line; an approval without a line is never listed', async t => {
  paymentWorld(t);
  const handlers = portalHandlers(NOW);
  const billed = (await portalView(handlers, await portalCookie('billed-change'), UNIFIED)).body;
  assert.deepEqual(billed.payment.changes, [{ id: 'change-decision-freezer', name: 'Approved change: Haul the old freezer', description: 'Synthetic crew note: it sits by the side door.', amount: 150 }]);
  assert.equal(billed.estimate.amount, 1000, 'the estimate card keeps the signed quote');
  assert.equal(billed.estimate.fingerprint, (await portalView(handlers, await portalCookie('billed-change'), OFF)).body.estimate.fingerprint, 'the approval binding is the same in every mode');
  const unbilled = (await portalView(handlers, await portalCookie('unbilled-change'), UNIFIED)).body;
  assert.deepEqual([unbilled.payment.changes, unbilled.payment.total, unbilled.payment.approvedChanges], [[], 1000, 0]);
});

test('the closeout balance read is for business sessions only, and validates the job', async t => {
  paymentWorld(t);
  const crew = (await createHubSessionCookie(UNIFIED, 'crew1')).split(';')[0], staff = await hubCookie(UNIFIED);
  assert.equal((await closeoutRead(UNIFIED, 'billed-change', crew)).status, 403);
  assert.equal((await closeoutRead(UNIFIED, 'secure_vault', staff)).status, 400);
  assert.equal((await closeoutRead(UNIFIED, 'missing-job', staff)).status, 404);
  assert.equal((await read(jobPayment.onRequestGet({ env: UNIFIED, request: new Request(`${ORIGIN}/api/job-payment?job_id=billed-change`, { headers: { Origin: ORIGIN } }) }))).status, 401);
  const extra = await read(jobPayment.onRequestGet({ env: UNIFIED, request: new Request(`${ORIGIN}/api/job-payment?job_id=billed-change&config=tips`, { headers: { Cookie: staff, Origin: ORIGIN } }) }));
  assert.notEqual(extra.body.unified, true, 'the balance read takes job_id alone');
});

test('the Hub board module: off until the server says so, then the finance state and row read the unified totals', () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), lines = suite.split(/\r?\n/), line = prefix => { const found = lines.find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const { api, store, listeners, context } = hubModule();
  Object.assign(context, { jobs: () => [], jobStage: j => j.pipelineStatus || j.status, crewNames: () => [], esc: String, money: value => `$${Number(value || 0).toFixed(2)}`, badge: text => `[${text}]`, empty: text => text, dateLabel: () => 'date',
    portalInvitationControl: () => '', salesExitControl: () => '', S: { integrations: {} }, isManager: () => true, isOwnerAccount: () => false });
  Object.assign(context.window, { EGCLaborCosts: { state: () => 'hidden', record: () => null }, EGCPricingConfig: { owner: () => null } });
  vm.runInContext([line('const payMoney='), line('const day='), line('function financeState('), line('const ownerEconomics='), line('const laborBaseline='), line('const laborState='), line('function jobEconomics('), line('function financeBoard(')].join('\n'), context);
  const jobs = moneyJobs(), billed = jobs['billed-change'], unbilled = jobs['unbilled-change'];
  // Off: today's board (the quote only, the change not counted).
  assert.equal(api.enabled(), false);
  assert.deepEqual([context.financeState(billed).total, context.financeState(billed).balance], [1000, 500]);
  api.configure({ moneyApi: false });
  assert.equal(context.financeState(billed).total, 1000, 'a flags answer without unifiedTotals keeps it off');
  api.configure({ unifiedTotals: true });
  assert.equal(store.get('egc.moneyTotals.unified'), 'true');
  const state = context.financeState(billed);
  assert.deepEqual([state.total, state.paid, state.verifiedPaid, state.balance, state.approvedChanges, state.unbilledChange, state.moneyReview, state.invoice], [1150, 500, 500, 650, 150, false, false, 'not issued']);
  assert.deepEqual([context.financeState(unbilled).total, context.financeState(unbilled).balance, context.financeState(unbilled).unbilledChange], [1000, 500, true]);
  const tipped = context.financeState(jobs['tip-present']);
  assert.deepEqual([tipped.total, tipped.paid, tipped.balance], [1000, 700, 300], 'tips never enter the board\'s service money');
  const overdue = context.financeState({ ...billed, invoice: { number: 'INV-1', status: 'issued', amount: 1000, dueDate: '2026-09-01' } });
  assert.deepEqual([overdue.total, overdue.balance, overdue.invoice], [1150, 650, 'overdue']);
  const review = context.financeState({ ...billed, estimate: { ...billed.estimate, amount: 'n/a' }, total: 'n/a', priceQuoted: 'n/a' });
  assert.equal(review.moneyReview, true);
  // A scheduled job with no estimate yet is not money to review: today's row, which offers Create estimate.
  const { estimate: _estimate, total: _total, priceQuoted: _priced, customerApproval: _approval, ...unpricedJob } = { ...jobs['quote-only'], id: 'unpriced-job', quoteStatus: '' };
  const unpriced = context.financeState(unpricedJob);
  assert.deepEqual([unpriced.moneyReview, unpriced.total, unpriced.balance, unpriced.estimate], [false, 0, 0, 'not created']);
  assert.equal(context.financeState({ ...unpricedJob, payment: { amount: 'lots', verified: true } }).moneyReview, true, 'no quote plus unreadable money is still reviewed');
  context.jobs = () => [unbilled, billed, review === null ? billed : { ...billed, id: 'review-job', estimate: { ...billed.estimate, amount: 'n/a' }, total: 'n/a', priceQuoted: 'n/a' }, unpricedJob];
  const html = context.financeBoard();
  assert.equal(html.match(/\[Approved change not billed\]/g)?.length, 1, 'the unbilled approval is flagged on its finance row');
  assert.equal(html.match(/\[Amounts need review\]/g)?.length, 1, 'only the unreadable quote is flagged, never the unpriced job');
  assert.match(html, /opsFinanceAction\('unpriced-job','estimate'\)">Create estimate/);
  assert.match(html, /<b>\$1150\.00<\/b><small>\$650\.00 balance/);
  // A page reload in the same tab starts from the last answer; sign-out forgets it.
  assert.equal(hubModule('true').api.enabled(), true);
  listeners['egc:signout']();
  assert.deepEqual([api.enabled(), store.has('egc.moneyTotals.unified')], [false, false]);
  assert.equal(context.financeState(billed).total, 1000);
});

const MIRRORED = [CHANGE_ORDER_UNBILLED, 'money_quote_missing', 'money_quote_invalid', 'money_change_order_invalid', 'money_paid_invalid', 'money_tips_unknown', 'money_deposit_invalid'];
test('the Hub board module matches money-core to the cent over odd saved money', () => {
  const { api } = hubModule('true'), fixtures = Object.values(moneyJobs());
  const odd = [1e11, -1, 'x', '1e3', '12.345', '1,000', NaN, Infinity, {}, [], true, '', null, undefined, 0, '0.50', 1000000, 1000000.01];
  const builds = [
    v => ({ estimate: { amount: v } }), v => ({ total: v }), v => ({ total: 100, estimate: { amount: 100, depositRequired: v } }), v => ({ total: 100, deposit: { amount: v } }),
    v => ({ total: 100, approvedChangeTotal: v }), v => ({ total: 100, customerDecisions: [{ id: 'd', status: 'approved', priceDelta: v }] }),
    v => ({ total: 100, changeOrders: [{ id: 'change-d', decisionId: 'd', kind: 'fee', source: 'customer_decision', totalCents: v }] }),
    v => ({ total: 100, payment: { amount: v, verified: true } }), v => ({ total: 100, payment: { amount: 50, verified: true, tips: v } }),
    v => ({ total: 100, payment: { amount: 50, verified: true, tips: [{ sessionId: 'cs_test_t', amountCents: v, amount: v }] } }),
    v => ({ total: 100, payment: { amount: 80, verified: v, stripeSessions: [{ sessionId: 'cs_test_a', amount: 30, purpose: 'tip' }], tips: [{ paymentIntentId: 'pi_b', amountCents: 500 }] } }),
    v => ({ total: 100, payment: { amount: 80, verified: true, stripeSessions: [{ sessionId: 'cs_test_a', paymentIntentId: 'pi_a', amount: v, purpose: 'tip' }, { sessionId: 'cs_test_a', amount: 30, purpose: 'tip' }] } }),
    v => ({ total: 100, status: v, completedAt: v ? '' : NOW, invoice: { paid: v }, deposit: { paidAmount: v } }),
    // A completed job's deposit term (an unreadable one never holds up its balance) and an open job's.
    v => ({ total: 100, status: 'completed', estimate: { amount: 100, depositRequired: v }, payment: { amount: 30, verified: true } }), v => ({ total: 100, completedAt: v ? NOW : '', deposit: { amount: v }, payment: { amount: 30, verified: true } }),
  ];
  // The board's own figures, recognisable when the module falls back to them.
  const SENTINEL = { total: -1, paid: -1, verifiedPaid: -1, pendingPaid: -1, balance: -1, invoice: 'sentinel', dueDate: '' };
  let checked = 0;
  for (const job of [...fixtures, ...odd.flatMap(value => builds.map(build => ({ id: 'synthetic-odd', type: 'job', ...build(value) })))]) {
    const core = customerMoneyTotals(job, { unified: true }), board = api.totals(job);
    for (const key of ['quoteCents', 'approvedChangeCents', 'totalCents', 'paidCents', 'tipCents', 'appliedCents', 'balanceCents', 'overpaidCents', 'depositRequiredCents', 'depositPaidCents', 'depositDueCents', 'dueNowCents', 'purpose', 'remainderCents']) assert.equal(board[key], core[key], `${key} ${JSON.stringify(job).slice(0, 160)}`);
    const named = issues => [...issues].filter(issue => MIRRORED.includes(issue)).sort();
    assert.deepEqual(named(board.issues), named(core.issues), JSON.stringify(job).slice(0, 160));
    assert.equal(moneyUnpriced(board), moneyUnpriced(core), JSON.stringify(job).slice(0, 160));
    // One needs-review rule: the board falls back to its own figures exactly when the portal and its checkout call the
    // money unknown, and flags it "Amounts need review" exactly when the portal tells the customer to call (moneyReview).
    const served = customerMoneyState(job, 'unified'), due = customerDepositState(job, undefined, 'unified'), state = api.financeState(job, SENTINEL, '2026-09-22');
    assert.equal(state.total === SENTINEL.total, served.unknown === true, `unknown ${JSON.stringify(job).slice(0, 160)}`);
    assert.equal(due.unknown === true, served.unknown === true);
    assert.equal(state.moneyReview, served.unknown === true && served.unpriced !== true, `moneyReview ${JSON.stringify(job).slice(0, 160)}`);
    assert.equal(state.moneyReview, due.unknown === true && due.unpriced !== true);
    checked++;
  }
  assert.equal(checked, fixtures.length + odd.length * builds.length);
});

test('the closeout page shows the server balance only when the server serves unified money', async () => {
  const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), lines = html.split(/\r?\n/), line = prefix => { const found = lines.find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const run = async (answer, active = { jobId: 'billed-change', total: 1000, rate: 1000, paidToDate: 500 }) => {
    const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { id, value: id === 'j_payment_amount' ? '500' : '', textContent: '', className: '', disabled: false }); return nodes.get(id); }, asked = [];
    const context = vm.createContext({ ACTIVE: { ...active }, document: { getElementById: node, querySelector: selector => selector === '#stripe_pay button' ? node('stripe-button') : null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, renderCrewTip() {},
      EGCHubAuth: { fetch: async (url, init) => { asked.push([url, init]); if (answer instanceof Error) throw answer; return new Response(JSON.stringify(answer), { status: answer.ok === false ? 403 : 200 }); } }, Response });
    vm.runInContext([line('function stripeStatus('), line('function updateStripePanel('), line('const CREW_CHECKOUT_ID='), line('function crewCheckoutRecord('), line('function crewCheckoutPending('), line('async function loadServerBalance(')].join('\n'), context);
    await context.loadServerBalance();
    return { context, node, asked };
  };
  const on = await run({ ok: true, jobId: 'billed-change', unified: true, balance: { totalCents: 115000, paidCents: 50000, balanceCents: 65000, approvedChangeCents: 15000 }, issues: [] });
  assert.deepEqual(on.asked.map(([url, init]) => [url, init.cache]), [['/api/job-payment?job_id=billed-change', 'no-store']]);
  assert.deepEqual([on.context.ACTIVE.total, on.context.ACTIVE.paidToDate, on.node('j_payment_amount').value, on.node('payment_hint').textContent], [1150, 500, '650', '$500.00 already recorded · $650.00 remaining']);
  assert.deepEqual([on.node('stripe-button').disabled, on.node('stripe_status').textContent], [false, '$650.00 outstanding · customer enters their card on Stripe.']);
  const flagged = await run({ ok: true, jobId: 'unbilled-change', unified: true, balance: { totalCents: 100000, paidCents: 50000, balanceCents: 50000, approvedChangeCents: 0 }, issues: [CHANGE_ORDER_UNBILLED] }, { jobId: 'unbilled-change', total: 1000, rate: 1000, paidToDate: 500 });
  assert.equal(flagged.node('payment_hint').textContent, '$500.00 already recorded · $500.00 remaining · an approved change is not billed yet (office review)');
  for (const answer of [{ ok: true, jobId: 'billed-change', unified: false }, { ok: true, jobId: 'another-job', unified: true, balance: { totalCents: 1, paidCents: 0, balanceCents: 1 } }, { ok: false, error: 'Only a manager can read the closeout balance' }, new Error('offline')]) {
    const off = await run(answer);
    assert.deepEqual([off.context.ACTIVE.total, off.context.ACTIVE.paidToDate, off.node('j_payment_amount').value, off.node('payment_hint').textContent], [1000, 500, '500', ''], JSON.stringify(answer));
  }
  const review = await run({ ok: true, jobId: 'billed-change', unified: true, balance: null, issues: ['money_quote_invalid'] });
  assert.equal(review.context.ACTIVE.moneyReview, true);
  assert.deepEqual([review.node('stripe-button').disabled, review.node('stripe_status').className], [true, 'stripe-status bad']);
  assert.match(review.node('stripe_status').textContent, /need a manager review/);
});

test('/api/integration-status adds unifiedTotals only with MONEY_UNIFIED_TOTALS=true and MONEY_API_ENABLED=true', async () => {
  const { onRequestGet } = await import('../functions/api/integration-status.js');
  const cookie = await hubCookie(OFF), flags = async extra => (await (await onRequestGet({ request: new Request(`${ORIGIN}/api/integration-status`, { headers: { Cookie: cookie } }), env: { ...OFF, ...extra } })).json()).flags;
  assert.deepEqual(await flags({}), { moneyApi: false, lifecycleApi: false });
  assert.deepEqual(await flags({ MONEY_UNIFIED_TOTALS: 'shadow' }), { moneyApi: false, lifecycleApi: false }, 'shadow serves today\'s board');
  assert.deepEqual(await flags({ MONEY_UNIFIED_TOTALS: 'shadow', MONEY_API_ENABLED: 'true' }), { moneyApi: true, lifecycleApi: false });
  // The browser finance tools (MONEY_API_ENABLED unset) cap and record on today's figures, so the board keeps them too.
  assert.deepEqual(await flags({ MONEY_UNIFIED_TOTALS: 'true' }), { moneyApi: false, lifecycleApi: false });
  assert.deepEqual(await flags({ MONEY_UNIFIED_TOTALS: 'true', MONEY_API_ENABLED: 'true' }), { moneyApi: true, lifecycleApi: false, unifiedTotals: true });
});

test('the Hub money actions cap, record and invoice unified money: the audit example no longer overpays or bills an unbilled change', async () => {
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  const store = mode => {
    const docs = new Map([['jobs/unbilled-change', { ...moneyJobs()['unbilled-change'], revision: 'r0' }]]);
    let n = 0;
    return { docs, totalsMode: mode, paymentEvents: false, read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
      async commit(writes) {
        for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
        for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...applyWrite(write.revision || write.exists ? docs.get(key) : {}, write), id: write.id, revision: `r${++n}` }); }
      } };
  };
  const run = (target, action, fields) => mutateMoney(target, owner, { action, requestId: crypto.randomUUID(), jobId: 'unbilled-change', expectedRevision: target.docs.get('jobs/unbilled-change').revision, ...fields }, NOW);
  // Today: money-core owes $650, so $650 cash is accepted and the portal (which never counted the approval) shows it overpaid.
  const today = store('off');
  const cash = await run(today, 'payment.record_offline', { amountCents: 65000, method: 'cash', reference: 'Synthetic cash 1' });
  assert.deepEqual([cash.job.totals.totalCents, cash.job.totals.balanceCents], [115000, 0]);
  // Unified: the balance is $500; $650 is refused, $500 settles it and the invoice bills only the quote.
  const unified = store('unified');
  await assert.rejects(run(unified, 'payment.record_offline', { amountCents: 65000, method: 'cash', reference: 'Synthetic cash 2' }), { code: 'money_amount_exceeds_balance', details: { balanceCents: 50000 } });
  const issued = await run(unified, 'invoice.issue', { dueDate: '2026-09-29' });
  assert.deepEqual([issued.job.totals.totalCents, issued.job.totals.balanceCents, issued.job.totals.issues, issued.job.invoice.amountCents], [100000, 50000, [CHANGE_ORDER_UNBILLED], 100000]);
  assert.deepEqual(unified.docs.get('jobs/unbilled-change').invoice.lineItems.map(line => line.id), ['reset']);
  const settled = await run(unified, 'payment.record_offline', { amountCents: 50000, method: 'cash', reference: 'Synthetic cash 3' });
  assert.deepEqual([settled.job.totals.balanceCents, settled.job.invoice.status], [0, 'paid']);
  const portal = customerMoneyState(unified.docs.get('jobs/unbilled-change'), 'unified');
  assert.deepEqual(portal, { total: 1000, paid: 1000, balance: 0 }, 'the portal agrees with the Hub to the cent');
});

// The Hub finance board as the page renders it: the suite's financeState and financeBoard over the pure module.
function hubBoard(sessionValue = 'true') {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), lines = suite.split(/\r?\n/), line = prefix => { const found = lines.find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const { api, context } = hubModule(sessionValue);
  Object.assign(context, { jobs: () => [], jobStage: j => j.pipelineStatus || j.status, crewNames: () => [], esc: String, money: value => `$${Number(value || 0).toFixed(2)}`, badge: text => `[${text}]`, empty: text => text, dateLabel: () => 'date', timeLabel: () => 'time',
    portalInvitationControl: () => '', salesExitControl: () => '', S: { integrations: {} }, isManager: () => true, isOwnerAccount: () => false });
  Object.assign(context.window, { EGCLaborCosts: { state: () => 'hidden', record: () => null }, EGCPricingConfig: { owner: () => null } });
  vm.runInContext([line('const payMoney='), line('const day='), line('function financeState('), line('const ownerEconomics='), line('const laborBaseline='), line('const laborState='), line('function jobEconomics('), line('function financeBoard('),
    line('function communicationActions('), line('function reviewRequestState('), line('function communicationBoard(')].join('\n'), context);
  return { api, context };
}
// A saved deposit term that is not dollars and cents (money_deposit_invalid) on the deposit-paid fixture.
const unreadableDeposit = (id, extra = {}) => { const job = moneyJobs()['deposit-paid']; return { ...job, id, estimate: { ...job.estimate, depositRequired: '500.00 USD' }, ...extra }; };

test('one needs-review rule: an unreadable deposit term holds only a deposit checkout, and the portal, card cap and Hub board agree', async t => {
  const jobs = { 'deposit-term-open': unreadableDeposit('deposit-term-open'), 'deposit-term-done': unreadableDeposit('deposit-term-done', { status: 'completed', pipelineStatus: 'completed', completedAt: NOW }) };
  const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW), staff = await hubCookie(UNIFIED), { context } = hubBoard();
  // While the deposit is what is due, the term decides the charge: money for the team to review, everywhere.
  const open = { ...world.store.job('deposit-term-open'), id: 'deposit-term-open' }, openCore = customerMoneyTotals(open, { unified: true });
  assert.deepEqual([openCore.issues, openCore.purpose, openCore.depositRequiredCents, openCore.balanceCents], [['money_deposit_invalid'], 'deposit', null, 50000]);
  assert.equal(customerMoneyState(open, 'unified').unknown, true);
  assert.throws(() => payable(open, 'unified'), { code: 'CUSTOMER_PORTAL_MONEY_REVIEW', message: MONEY_REVIEW_TEXT });
  assert.deepEqual([(await portalView(handlers, await portalCookie('deposit-term-open'), UNIFIED)).body.payment.moneyReview, (await cardProbe(UNIFIED, 'deposit-term-open', staff, 5000)).body.code], [true, 'JOB_PAYMENT_MONEY_REVIEW']);
  assert.equal(context.financeState(open).moneyReview, true, 'the Hub row flags what the portal refuses');
  // A completed job charges its balance: the deposit term no longer decides anything, so it is not held up.
  const done = { ...world.store.job('deposit-term-done'), id: 'deposit-term-done' }, core = customerMoneyTotals(done, { unified: true });
  assert.deepEqual([core.issues, core.purpose, core.dueNowCents, core.remainderCents, core.depositRequiredCents], [['money_deposit_invalid'], 'balance', 50000, 0, null]);
  assert.deepEqual(customerMoneyState(done, 'unified'), { total: 1000, paid: 500, balance: 500 });
  assert.deepEqual(customerDepositState(done, undefined, 'unified'), { required: null, paid: null, due: null, dueNow: 500, purpose: 'balance', remainder: 0 }, 'the unreadable deposit figures stay unknown, never 0');
  assert.equal(payable(done, 'unified').dueNow, 500);
  const view = (await portalView(handlers, await portalCookie('deposit-term-done'), UNIFIED)).body.payment;
  assert.deepEqual([view.moneyReview, view.total, view.balance, view.dueNow, view.purpose], [false, 1000, 500, 500, 'balance']);
  const pay = await portalPost(handlers, await portalCookie('deposit-term-done'), { action: 'create_payment', request_id: 'pay-deposit-term-done' }, UNIFIED);
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.deepEqual(world.created.map(item => [item.kind, item.unitAmount]), [['egc_customer_portal_payment', 50000]]);
  assert.equal((await cardProbe(UNIFIED, 'deposit-term-done', staff, 50000)).status, 200);
  assert.deepEqual((await closeoutRead(UNIFIED, 'deposit-term-done', staff)).body.balance, { totalCents: 100000, paidCents: 50000, balanceCents: 50000, approvedChangeCents: 0 });
  const row = context.financeState(done);
  assert.deepEqual([row.total, row.balance, row.moneyReview], [1000, 500, false], 'the Hub row shows the balance the portal charges');
  context.jobs = () => [open, done];
  assert.equal(context.financeBoard().match(/\[Amounts need review\]/g)?.length, 1, 'only the job the portal refuses is flagged');
});

test('an invoice issued before the flip lists the unified total its paid and balance are measured with, keeps its saved amount and is flagged stale', async () => {
  const saved = { number: 'INV-FLIP-1', status: 'issued', amount: 1150, dueDate: '2026-09-29', issuedAt: '2026-09-22T17:00:00.000Z' };
  const invoiced = { ...moneyJobs()['unbilled-change'], invoice: saved }, store = mode => ({ totalsMode: mode, paymentEvents: false, jobs: async () => [{ ...invoiced, revision: 'r1' }] });
  const list = async mode => (await listMoney(store(mode), { view: 'invoices' }, NOW)).items[0];
  // The row matches the invoice document the customer opens.
  const unified = await list('unified'), doc = rows(moneyDocumentModel(invoiced, { kind: 'invoice', now: NOW, unified: true }));
  assert.deepEqual([unified.amountCents, unified.paidCents, unified.balanceCents], [doc.Total, doc['Payments received'], doc['Balance due']]);
  assert.deepEqual([unified.amountCents, unified.paidCents, unified.balanceCents, unified.savedAmountCents, unified.issues], [100000, 50000, 50000, 115000, ['invoice_amount_stale']]);
  assert.match(moneyCsv('invoices', [unified]), /"INV-FLIP-1"[^\r\n]*"1000\.00","500\.00","500\.00"/, 'the export adds up too');
  // The /api/money job view says the same.
  const projected = moneyProjection({ ...invoiced, revision: 'r1' }, NOW, { unified: true }).invoice;
  assert.deepEqual([projected.amountCents, projected.savedAmountCents, projected.issues], [100000, 115000, ['invoice_amount_stale']]);
  // Off and shadow: exactly today's row and job view, with no new fields.
  for (const mode of ['off', 'shadow']) {
    const today = await list(mode);
    assert.deepEqual([today.amountCents, today.paidCents, today.balanceCents, 'savedAmountCents' in today, 'issues' in today], [115000, 50000, 65000, false, false], mode);
  }
  assert.deepEqual(Object.keys(moneyProjection({ ...invoiced, revision: 'r1' }, NOW).invoice), ['status', 'savedStatus', 'number', 'amountCents', 'dueDate', 'issuedAt', 'customerReference', 'voidedAt', 'voidReason']);
  // An invoice issued in unified money is not stale; a void one keeps its saved figures.
  const fresh = { ...invoiced, invoice: invoiceFromEstimate(invoiced, { now: NOW, unified: true }).invoice };
  assert.deepEqual([moneyProjection(fresh, NOW, { unified: true }).invoice.amountCents, moneyProjection(fresh, NOW, { unified: true }).invoice.issues], [100000, []]);
  const voided = await listMoney({ totalsMode: 'unified', paymentEvents: false, jobs: async () => [{ ...invoiced, invoice: { ...saved, status: 'void', paid: 500, balance: 650 }, revision: 'r1' }] }, { view: 'invoices' }, NOW);
  assert.deepEqual([voided.items[0].amountCents, voided.items[0].paidCents, voided.items[0].balanceCents, 'savedAmountCents' in voided.items[0]], [115000, 50000, 65000, false]);
});

test('the Customer messages buttons and board quote today\'s figures, like the HighLevel notes they send', () => {
  const { api, context } = hubBoard();
  // Paid $1,000 on a $1,000 invoice, $100 of it an older tip: today owes nothing, unified money owes $100, past due.
  const jobs = withLegacyTip(moneyJobs()), tipped = { ...jobs['legacy-tip'], customerAutomationEnabled: true, notify: true, payment: { ...jobs['legacy-tip'].payment, amount: 1000 },
    invoice: { number: 'INV-TIP-1', status: 'issued', amount: 1000, paid: 900, balance: 100, dueDate: '2026-09-01', issuedAt: '2026-08-25T17:00:00.000Z' } };
  context.jobs = () => [tipped];
  assert.equal(api.enabled(), true);
  assert.deepEqual([context.financeState(tipped).balance, context.financeState(tipped).invoice], [100, 'overdue'], 'the finance board shows the unified $100 overdue');
  const actions = context.communicationActions(tipped);
  assert.doesNotMatch(actions, /Overdue reminder|Invoice due/, 'no reminder button that would send a "Balance $0.00" note');
  assert.match(actions, /opsTriggerCommunication\('legacy-tip','payment-received'\)">Payment receipt/);
  assert.match(context.communicationBoard(), /<strong>\$0\.00<\/strong><span>open balance/);
  // A job today's figures call overdue keeps its button and open balance, exactly as before.
  const owed = { ...tipped, payment: { ...tipped.payment, amount: 600 } };
  context.jobs = () => [owed];
  assert.match(context.communicationActions(owed), /opsTriggerCommunication\('legacy-tip','invoice-overdue'\)">Overdue reminder/);
  assert.match(context.communicationBoard(), /<strong>\$400\.00<\/strong><span>open balance/);
});

test('the crew closeout\'s HighLevel payment note quotes today\'s figures while the card cap and invoice mirror use unified money', async t => {
  const world = paymentWorld(t, withLegacyTip(moneyJobs())), staff = await hubCookie(UNIFIED);
  // Today $600 of $1,000 is paid ($100 of it an older tip); unified money has $500 applied, so the card cap is $500.
  assert.equal((await cardProbe(UNIFIED, 'legacy-tip', staff, 50001)).status, 409);
  assert.equal((await cardProbe(UNIFIED, 'legacy-tip', staff, 20000)).status, 200);
  const session = world.created.at(-1);
  world.complete(session.id, { paymentIntentId: 'pi_legacy_tip_crew', chargeId: 'ch_legacy_tip_crew', receiptUrl: 'https://pay.stripe.com/receipts/legacy-tip-crew' });
  const verify = () => read(jobPayment.onRequestGet({ env: UNIFIED, request: new Request(`${ORIGIN}/api/job-payment?session_id=${session.id}`, { headers: { Cookie: staff, Origin: ORIGIN } }) }));
  const first = await verify(), saved = world.store.job('legacy-tip');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Today: $800 recorded, $200 owed (the note crew/postjob.html sends to HighLevel). Unified: $700 applied, $300 owed.
  assert.deepEqual([first.body.duplicate, first.body.paymentSyncPayload.amount, first.body.paymentSyncPayload.paidTotal, first.body.paymentSyncPayload.balance], [false, 200, 800, 200]);
  assert.deepEqual([saved.paymentSyncPayload.paidTotal, saved.paymentSyncPayload.balance, saved.payment.amount], [800, 200, 800]);
  assert.deepEqual([saved.invoice.amount, saved.invoice.paid, saved.invoice.balance], [1000, 700, 300], 'the invoice mirror is unified money');
  // A second return finds the charge on the job and quotes the same figures.
  const again = await verify();
  assert.deepEqual([again.body.duplicate, again.body.paymentSyncPayload.paidTotal, again.body.paymentSyncPayload.balance], [true, 800, 200]);
});

// A tipped portal charge held off its job (paid after the job closed), and the Review queues POST that closes it.
function heldTipWorld(job) {
  const rows = new Map(), put = (path, value) => rows.set(path, { value: structuredClone(value), revision: `2026-09-22T00:00:00.${String(rows.size + 1).padStart(6, '0')}Z` });
  put('jobs/legacy-tip', job);
  put('payment_reviews/cs_test_legacy_tip_held', { sessionId: 'cs_test_legacy_tip_held', jobId: 'legacy-tip', kind: 'egc_customer_portal_payment', reason: 'payment_tip_refused', status: 'open', amountCents: 11000, tipCents: 1000, jobLedgerIds: [], currency: 'usd',
    paymentIntentId: 'pi_legacy_tip_held', livemode: false, createdBy: 'customer_portal', recordedBy: 'customer_portal', createdAt: '2026-09-22T11:00:00.000Z' });
  const out = (path, row) => ({ ...structuredClone(row.value), id: path.split('/').slice(1).join('/'), revision: row.revision });
  const store = {
    async read(collection, id) { const path = `${collection}/${id}`; return rows.has(path) ? out(path, rows.get(path)) : null; },
    async commit(writes) {
      for (const write of writes) { const row = rows.get(`${write.collection}/${write.id}`); if (write.revision ? row?.revision !== write.revision : row) throw Object.assign(new Error('Synthetic conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) if (!write.verify) put(`${write.collection}/${write.id}`, { ...(rows.get(`${write.collection}/${write.id}`)?.value || {}), ...structuredClone(write.patch) });
    },
  };
  const stripe = async path => ({ id: 'cs_test_legacy_tip_held', client_reference_id: 'legacy-tip', metadata: { job_id: 'legacy-tip' }, amount_total: 11000, livemode: false, payment_intent: { id: 'pi_legacy_tip_held', latest_charge: { amount_refunded: 0, refunded: false } }, path });
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  const handlers = stripeReviewHandlers({ session: async () => owner, storage: () => store, stripe: () => stripe, now: () => new Date(NOW) });
  const reconcile = async (env, extra = {}) => {
    const review = await store.read('payment_reviews', 'cs_test_legacy_tip_held');
    return read(handlers.post({ env, request: new Request(`${ORIGIN}/api/stripe-reviews`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'payment.reconcile', requestId: crypto.randomUUID(), reviewId: review.id, expectedRevision: review.revision, note: 'Service recorded by hand', ...extra }) }) }));
  };
  return { store, reconcile };
}

test('closing a held tipped charge measures its service part against the balance a new checkout would charge: no second collection in unified mode', async () => {
  // Paid $1,000 on a $1,000 quote with $100 of it an older tip: today's balance is $0, unified money still owes $100.
  const jobs = withLegacyTip(moneyJobs()), job = { ...jobs['legacy-tip'], payment: { ...jobs['legacy-tip'].payment, amount: 1000 } };
  assert.deepEqual([customerMoneyState(job).balance, customerMoneyState(job, 'unified').balance], [0, 100]);
  // Flag off (and shadow): today's rule, the $0 balance lets the review close.
  for (const env of [OFF, SHADOW]) assert.equal((await heldTipWorld(job).reconcile(env)).status, 200);
  // Unified: closing it would give Pay back for $100 this charge may already have paid, so its service part comes first.
  const world = heldTipWorld(job), refused = await world.reconcile(UNIFIED);
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'stripe_review_service_not_recorded', { amountCents: 11000, tipCents: 1000, serviceCents: 10000, recordedSinceCents: 0, jobBalanceCents: 10000 }]);
  assert.match(refused.body.error, /^Not on the job: closing this review lets the job's \$100\.00 balance be paid again\./);
  assert.equal((await world.store.read('payment_reviews', 'cs_test_legacy_tip_held')).status, 'open', 'nothing was saved');
  const elsewhere = await world.reconcile(UNIFIED, { appliedElsewhere: true });
  assert.deepEqual([elsewhere.status, elsewhere.body.review.serviceAppliedElsewhere], [200, true]);
  // Unified money that cannot be read counts as owed: the review waits for the service part, the balance unnamed.
  const unknown = await heldTipWorld({ ...job, estimate: { ...job.estimate, amount: 'n/a' }, total: 'n/a', priceQuoted: 'n/a' }).reconcile(UNIFIED);
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.details.jobBalanceCents], [409, 'stripe_review_service_not_recorded', null]);
  assert.match(unknown.body.error, /^Not on the job: closing this review lets the job's balance be paid again\./);
});
