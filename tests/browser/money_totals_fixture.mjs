// Prints the customer portal answers tests/browser/test_money_totals_ui.py routes to the page (FIX-MONEY-TOTALS), all
// produced by the real handlers (functions/api/customer-portal.js) over tests/helpers/money-totals-fixture.mjs: the
// completed $1,000 job with its $500 deposit paid and a billed $150 change, with MONEY_UNIFIED_TOTALS on and off, the
// same approval recorded without a billed line, a job whose saved quote cannot be read and a job with no quote saved
// yet (unified and off). It also opens the real
// portal checkout for the billed job and reports the Stripe unit_amount. Time is fixed; nothing leaves the process.
import assert from 'node:assert/strict';
import { portalCookie, portalHandlers, portalPost, portalView } from '../helpers/portal-fixture.mjs';
import { NOW, OFF, UNIFIED, moneyJobs, paymentWorld } from '../helpers/money-totals-fixture.mjs';

const jobs = moneyJobs();
jobs['text-quote'] = { ...jobs['billed-change'], id: 'text-quote', total: '1,000', priceQuoted: '1,000', estimate: { ...jobs['billed-change'].estimate, amount: '1,000' } };
const { estimate: _estimate, total: _total, priceQuoted: _priced, customerApproval: _approval, ...unpriced } = jobs['quote-only'];
jobs.unpriced = { ...unpriced, id: 'unpriced', quoteStatus: '' };
const t = { mock: { method: (object, name, impl) => { object[name] = impl; } } };
const world = paymentWorld(t, jobs), handlers = portalHandlers(NOW);
const view = async (id, env) => (await portalView(handlers, await portalCookie(id), env)).body;
const unified = await view('billed-change', UNIFIED), off = await view('billed-change', OFF), unbilled = await view('unbilled-change', UNIFIED), review = await view('text-quote', UNIFIED);
const noQuote = await view('unpriced', UNIFIED), noQuoteOff = await view('unpriced', OFF);
const pay = await portalPost(handlers, await portalCookie('billed-change'), { action: 'create_payment', request_id: 'pay-browser-money-totals' }, UNIFIED);
assert.equal(pay.status, 200);
process.stdout.write(JSON.stringify({ unified, off, unbilled, review, noQuote, noQuoteOff, checkout: { url: pay.body.url, unitAmount: world.created[0].unitAmount, amount: pay.body.amount } }));
