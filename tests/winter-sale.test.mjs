import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { menuPrices, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { estimateTotals } from '../functions/_lib/quote-model.js';
import { customerMoneyTotals } from '../functions/_lib/money-core.js';
import { previewQuoteSend, saveQuoteDraft, sendQuoteDraft } from '../functions/_lib/quote-draft.js';
import { WINTER_SALE_DEFAULTS, WINTER_SALE_LINE_ID, estimatedSaleMargin, mutateWinterSaleSettings, readWinterSaleSettings, winterSaleCap, winterSaleDecision, winterSaleLine } from '../functions/_lib/winter-sale.js';
import { jobActualsHandlers } from '../functions/api/job-actuals.js';
import { HUB_AUDIT_COLLECTION } from '../functions/_lib/hub-audit.js';
import { LABOR, builderState, client, estimator, fixture, menuItem, owner, selection, SHELF, TOTES } from './helpers/estimator-fixture.mjs';
import { env as portalEnv, portalCookie, portalHandlers, portalPost, portalStore, portalView } from './helpers/portal-fixture.mjs';

// Early-bird winter sale (owner decisions 2026-10-21): up to $400 off any job, accepted by 2027-01-31 (Denver), work
// 2026-12-01..2027-02-28, the amount capped by a 30% margin floor on the Job actuals cost settings, owner override audited.
const ON = { HUB_SESSION_SECRET: 'synthetic-winter-sale-secret-0123456789', EGC_STAFF_ROLE_PERMISSIONS: 'true', EGC_QUOTE_BUILDER_ENABLED: 'true', EGC_WINTER_SALE: 'true' };
const OFF = { ...ON, EGC_WINTER_SALE: 'false' };
const NOW = '2026-10-17T15:00:00.000Z';
// Synthetic cost settings (every key entered) that leave the test quote well above the floor, and ones that do not.
const LOW_COSTS = { wageCentsPerManHour: 2000, workersCompBp: 0, payrollTaxBp: 0, burdenCentsPerManHour: 0, dumpFeeCentsPerLoad: 5000, truckCentsPerJob: 1000, goodsTaxBp: 0 };
const HIGH_COSTS = { ...LOW_COSTS, wageCentsPerManHour: 20000, dumpFeeCentsPerLoad: 400000 };
const readers = (costs = LOW_COSTS, settings = WINTER_SALE_DEFAULTS, setter = false) => ({ settings: async () => ({ revision: null, ...settings }), costs: async () => costs, setter: async () => setter });
const allApproved = () => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState(prices); };
const id = name => menuItem(name).id;
// Two-car base, two full trucks, shelving and totes, 6 man-hours: a normal job that takes the full $400. A small one.
const BIG = selection({ removal: [{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 2 }], shelving: [{ id: SHELF.id, quantity: 2 }], storage: [{ id: TOTES.id, quantity: 2 }], labor: LABOR });
const SMALL = selection({ removal: [{ id: id('Two-car garage base'), quantity: 1 }], shelving: [], storage: [], labor: { manHours: 2, fullness: 'light' } });

function quote(sel, state = allApproved()) {
  const priced = priceCompositeQuote(state, sel, { complete: true });
  return { priced, state, draft: extra => ({ client: client(1), title: 'Garage reset', scope: 'Reset.', line_items: priced.lineItems, valid_until: '2026-10-30', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 240, composite_pricing: priced.compositePricing, ...extra }) };
}
async function save(f, actor, q, { sale, env = ON, sale_readers = readers(), now = NOW, extra = {}, jobId = null } = {}) {
  const job = jobId ? f.job(jobId) : null;
  return saveQuoteDraft(f.store, actor, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', ...(job ? { jobId, expectedRevision: job.revision } : { sourceRevision: f.rows.get('jobs/w1').revision }), draft: q.draft({ ...(sale === undefined ? {} : { winter_sale: sale }), ...extra }) }, now,
    { env, compositeState: async () => q.state, winterSale: sale_readers });
}

test('the decision: any job, the Denver sign-by day, the job window and the margin cap, each with a plain reason', () => {
  const full = { known: true, capCents: 40000 }, base = { beforeCents: 200000, today: '2027-01-31', jobDate: '2026-12-01', cap: full };
  assert.deepEqual(winterSaleDecision(base), { eligible: true, code: 'eligible', reason: 'Eligible.', overridden: false, amountCents: 40000 }, 'the last sign-by day, the first job day');
  assert.equal(winterSaleDecision({ ...base, beforeCents: 60000 }).amountCents, 40000, 'no minimum: a $600 job takes the full sale when its margin allows');
  assert.equal(winterSaleDecision({ ...base, today: '2027-02-01' }).code, 'sale_ended');
  for (const [day, code] of [['2026-11-30', 'job_date_outside'], ['2026-12-01', 'eligible'], ['2027-02-28', 'eligible'], ['2027-03-01', 'job_date_outside']]) assert.equal(winterSaleDecision({ ...base, jobDate: day }).code, code, day);
  assert.equal(winterSaleDecision({ ...base, jobDate: null }).code, 'eligible', 'a draft without a job date yet may carry the sale');
  assert.equal(winterSaleDecision({ ...base, jobDate: null, requireJobDate: true }).code, 'job_date_needed', 'a send needs the booked day');
  // The cap: less than the sale on a job the margin floor limits, none (no line) when it is already below the floor.
  assert.deepEqual(winterSaleDecision({ ...base, cap: { known: true, capCents: 12300 } }), { eligible: true, code: 'capped', reason: 'Eligible for $123.00 off on this job (the sale is up to $400.00). Ask Zac for more.', overridden: false, amountCents: 12300 });
  assert.deepEqual(winterSaleDecision({ ...base, cap: { known: true, capCents: 0 } }), { eligible: false, code: 'below_floor', reason: 'Not eligible: below the margin floor. Ask Zac.', overridden: false, amountCents: 0 });
  assert.equal(winterSaleDecision({ ...base, cap: { known: false, reason: 'costs_missing' } }).reason, 'Enter labor costs in Job actuals settings to use the winter sale.');
  assert.equal(winterSaleDecision({ ...base, cap: { known: false, reason: 'labor_unknown' } }).code, 'margin_unknown');
  assert.equal(winterSaleDecision({ ...base, cap: { known: false, reason: 'junk_hours_missing' } }).code, 'margin_unknown');
  // Never the whole total: at most the whole dollars below it, and nothing on a quote of $1 or less.
  assert.equal(winterSaleDecision({ ...base, beforeCents: 25050 }).amountCents, 25000);
  assert.equal(winterSaleDecision({ ...base, beforeCents: 100 }).code, 'nothing_to_discount');
  // The owner may give the full amount past the margin rule; never past the date terms.
  const override = { reason: 'Repeat customer, crew idle that week' };
  for (const cap of [{ known: true, capCents: 0 }, { known: true, capCents: 12300 }, { known: false, reason: 'costs_missing' }]) assert.deepEqual(winterSaleDecision({ ...base, cap, override, ownerOverride: true }), { eligible: true, code: 'owner_override', reason: 'Eligible (owner override).', overridden: true, amountCents: 40000 });
  assert.equal(winterSaleDecision({ ...base, cap: { known: true, capCents: 0 }, override, ownerOverride: false }).code, 'below_floor', 'only the owner overrides');
  assert.equal(winterSaleDecision({ ...base, jobDate: '2027-03-01', override, ownerOverride: true }).code, 'job_date_outside');
  // No reason ever names a margin, a cost or a percentage.
  for (const cap of [full, { known: true, capCents: 100 }, { known: true, capCents: 0 }, { known: false, reason: 'costs_missing' }]) assert.doesNotMatch(winterSaleDecision({ ...base, cap }).reason, /%|margin of|\d+ (man-)?hours/i);
});

test('the cap: a normal job takes the full $400, a small one less, a junk-only one by the owner\'s hours per load, never the whole total', () => {
  const service = cents => [{ id: 'svc', kind: 'service', name: 'Work', quantity: 1, unitCents: cents, totalCents: cents }];
  const costs = { ...LOW_COSTS, dumpFeeCentsPerLoad: 0 };
  const at = (lines, manHours, c, cents, channel = 'direct_estimator') => estimatedSaleMargin({ lineItems: [...lines, winterSaleLine(WINTER_SALE_DEFAULTS, cents)], manHours, costs: c, channel });
  assert.deepEqual(winterSaleCap({ lineItems: service(300000), manHours: 10, costs, channel: 'direct_estimator' }), { known: true, capCents: 40000 });
  // A $600 job with 3 man-hours at a high synthetic wage: the largest whole-dollar discount that keeps the floor.
  const small = { ...costs, wageCentsPerManHour: 10000 }, cap = winterSaleCap({ lineItems: service(60000), manHours: 3, costs: small, channel: 'direct_estimator' });
  assert.ok(cap.capCents > 0 && cap.capCents < 40000 && cap.capCents % 100 === 0, JSON.stringify(cap));
  assert.ok(at(service(60000), 3, small, cap.capCents).marginBp >= 3000 && at(service(60000), 3, small, cap.capCents + 100).marginBp < 3000);
  // Junk-only: one full truck load, no Labor line; its crew time is the owner's man-hours per load.
  const truck = [{ id: 'removal-junk-full', kind: 'service', name: 'Full truck load', quantity: 1, unitCents: 75000, totalCents: 75000 }];
  const junkCosts = { ...LOW_COSTS, wageCentsPerManHour: 10000, dumpFeeCentsPerLoad: 15000, truckCentsPerJob: 5000 }, perLoad = { ...WINTER_SALE_DEFAULTS, junkManHoursPerLoad: 2 };
  assert.deepEqual(winterSaleCap({ lineItems: truck, junkOnly: true, costs: junkCosts, channel: 'junk_only' }), { known: false, reason: 'junk_hours_missing' });
  const junk = winterSaleCap({ lineItems: truck, junkOnly: true, costs: junkCosts, channel: 'junk_only', settings: perLoad });
  assert.ok(junk.capCents > 0 && junk.capCents < 40000, JSON.stringify(junk));
  assert.ok(at(truck, 2, junkCosts, junk.capCents, 'junk_only').marginBp >= 3000 && at(truck, 2, junkCosts, junk.capCents + 100, 'junk_only').marginBp < 3000);
  // Never the whole total, whatever the costs allow: a $250 job keeps at least a dollar.
  assert.deepEqual(winterSaleCap({ lineItems: service(25000), manHours: 0.25, costs: { ...costs, wageCentsPerManHour: 100, truckCentsPerJob: 0 }, channel: 'none' }), { known: true, capCents: 24900 });
  // Already below the floor before the sale: none at all. Costs not entered: unknown.
  assert.deepEqual(winterSaleCap({ lineItems: service(60000), manHours: 10, costs: small, channel: 'direct_estimator' }), { known: true, capCents: 0 });
  assert.deepEqual(winterSaleCap({ lineItems: service(60000), manHours: 3, costs: { ...costs, wageCentsPerManHour: null }, channel: 'none' }), { known: false, reason: 'costs_missing' });
});

test('the margin estimate costs the quote with the Job actuals cost model: labor, goods, dump, truck and commission', () => {
  const lines = [{ id: 'svc', kind: 'service', name: 'Work', quantity: 1, unitCents: 300000, totalCents: 300000 }, winterSaleLine()];
  // Revenue $2,600; labor 10 h x $20 = $200; no goods, loads or truck in these lines except $10 truck; 7% commission $182.
  const costs = { ...LOW_COSTS, dumpFeeCentsPerLoad: 0 };
  const margin = estimatedSaleMargin({ lineItems: lines, manHours: 10, costs, channel: 'direct_estimator' });
  assert.deepEqual(margin, { known: true, marginBp: Math.round((260000 - 20000 - 1000 - 18200) * 10000 / 260000) });
  assert.deepEqual(estimatedSaleMargin({ lineItems: lines, manHours: 10, costs: { ...costs, wageCentsPerManHour: null }, channel: 'none' }), { known: false, reason: 'costs_missing' });
  assert.deepEqual(estimatedSaleMargin({ lineItems: lines, manHours: null, costs, channel: 'none' }), { known: false, reason: 'labor_unknown' });
  // A door-to-door setter's walkthrough costs more commission than the estimator's own.
  assert.ok(estimatedSaleMargin({ lineItems: lines, manHours: 10, costs, channel: 'appointment_setter' }).marginBp < margin.marginBp);
});

test('an eligible quote gets its own sale line, a lower total and deposit; Labor stays one line and amount', async () => {
  const f = fixture(ON), q = quote(BIG), saved = await save(f, estimator, q, { sale: { apply: true } }), job = f.job(saved.job.id);
  const lines = job.estimate.lineItems, sale = lines.find(line => line.id === WINTER_SALE_LINE_ID), before = q.priced.totalCents;
  assert.deepEqual([sale.kind, sale.name, sale.totalCents, sale.quantity], ['discount', 'Early-bird winter sale', -40000, 1]);
  assert.equal(job.estimate.amountCents, before - 40000);
  assert.equal(estimateTotals(lines).totalCents, before - 40000);
  assert.equal(lines.filter(line => line.kind === 'labor').length, 1, 'D-LABOR-TEXT: Labor is untouched, one line');
  assert.equal(lines.find(line => line.kind === 'labor').totalCents, q.priced.lineItems.find(line => line.kind === 'labor').totalCents);
  assert.deepEqual(saved.job.winterSale, { requested: true, applied: true, amountCents: 40000, code: 'eligible', reason: 'Eligible.', overridden: false });
  assert.ok(saved.warnings.some(warning => warning.code === 'winter_sale_applied'));
  assert.equal(JSON.stringify(saved).includes('marginBp'), false, 'the estimator never sees a margin');
  // Invoices, the money ledger and Job actuals revenue all read the discounted quote total.
  assert.equal(customerMoneyTotals(job, { unified: true }).totalCents, before - 40000);
});

test('not applied: saved without the sale (no line at all) and the estimator is told why (missing costs, the margin floor)', async () => {
  const cases = [[BIG, { ...LOW_COSTS, wageCentsPerManHour: null }, 'costs_missing', /Enter labor costs in Job actuals settings/], [BIG, HIGH_COSTS, 'below_floor', /below the margin floor\. Ask Zac\./]];
  for (const [sel, costs, code, message] of cases) {
    const f = fixture(ON), q = quote(sel), saved = await save(f, estimator, q, { sale: { apply: true }, sale_readers: readers(costs) }), job = f.job(saved.job.id);
    assert.equal(job.estimate.lineItems.some(line => line.id === WINTER_SALE_LINE_ID), false, code);
    assert.equal(job.estimate.amountCents, q.priced.totalCents, code);
    assert.deepEqual([saved.job.winterSale.applied, saved.job.winterSale.code], [false, code]);
    assert.match(saved.warnings.find(warning => warning.code === 'winter_sale_not_applied').message, message);
  }
});

test('a small job gets the capped amount as its own line: the customer sees the amount actually given', async () => {
  // SMALL at a synthetic wage that leaves room for less than the full sale.
  const q = quote(SMALL), costs = { ...LOW_COSTS, wageCentsPerManHour: 15000, dumpFeeCentsPerLoad: 0, truckCentsPerJob: 30000 };
  const expected = winterSaleCap({ lineItems: q.priced.lineItems, manHours: 2, costs, channel: 'direct_estimator' });
  assert.ok(expected.capCents > 0 && expected.capCents < 40000, `the synthetic small job is capped (${JSON.stringify(expected)}, total ${q.priced.totalCents})`);
  const f = fixture(ON), saved = await save(f, estimator, q, { sale: { apply: true }, sale_readers: readers(costs) }), job = f.job(saved.job.id);
  const sale = job.estimate.lineItems.find(line => line.id === WINTER_SALE_LINE_ID);
  assert.deepEqual([sale.name, sale.totalCents], ['Early-bird winter sale', -expected.capCents]);
  assert.equal(job.estimate.amountCents, q.priced.totalCents - expected.capCents);
  assert.deepEqual([saved.job.winterSale.code, saved.job.winterSale.amountCents], ['capped', expected.capCents]);
  assert.doesNotMatch(JSON.stringify(saved), /marginBp|capCents/);
});

test('Denver time decides the sign-by day, and a sale quote expires on it at the latest', async () => {
  const q = quote(BIG), late = { ...q, draft: extra => ({ ...q.draft(extra), valid_until: '2027-03-15' }) };
  // 23:30 on Jan 31 in Denver is already Feb 1 in UTC: still the last sale day.
  const f = fixture(ON), lastNight = await save(f, estimator, late, { sale: { apply: true }, now: '2027-02-01T06:30:00.000Z' });
  assert.equal(lastNight.job.winterSale.applied, true);
  assert.equal(f.job(lastNight.job.id).estimate.validUntil, '2027-01-31', 'held to the sign-by day');
  const g = fixture(ON), nextMorning = await save(g, estimator, late, { sale: { apply: true }, now: '2027-02-01T07:30:00.000Z' });
  assert.deepEqual([nextMorning.job.winterSale.code, g.job(nextMorning.job.id).estimate.validUntil], ['sale_ended', '2027-03-15']);
});

test('only the owner applies it anyway, with a reason, and the override is audited in the same commit', async () => {
  const q = quote(BIG), override = { apply: true, override: { reason: 'Slow week, keep the crew busy' } };
  await assert.rejects(save(fixture(ON), estimator, q, { sale: override, sale_readers: readers(HIGH_COSTS) }), { code: 'winter_sale_override_forbidden', status: 403 });
  await assert.rejects(save(fixture(ON), owner, q, { sale: { apply: true, override: { reason: 'x' } }, sale_readers: readers(HIGH_COSTS) }), { code: 'winter_sale_override_invalid' });
  const f = fixture(ON), saved = await save(f, owner, q, { sale: override, sale_readers: readers(HIGH_COSTS) });
  assert.deepEqual([saved.job.winterSale.applied, saved.job.winterSale.overridden], [true, true]);
  const audits = f.writesTo(HUB_AUDIT_COLLECTION).filter(write => write.patch.action === 'quote.winter_sale.override');
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].patch.visibility, audits[0].patch.reason, audits[0].patch.entity.id], ['owner', 'Slow week, keep the crew busy', saved.job.id]);
  assert.equal(f.job(saved.job.id).quoteDraft.winterSale.override.by, 'zacb');
});

test('the line is the server\'s alone: a browser-sent sale line is refused, and a tampered builder line never saves', async () => {
  const q = quote(BIG);
  const forged = { id: WINTER_SALE_LINE_ID, kind: 'discount', name: 'Early-bird winter sale', quantity: 1, unitCents: -40000, totalCents: -40000 };
  await assert.rejects(save(fixture(ON), estimator, q, { extra: { line_items: [...q.priced.lineItems, forged] } }), { code: 'quote_draft_winter_sale_server_only', status: 400 });
  await assert.rejects(save(fixture(ON), estimator, q, { extra: { line_items: [...q.priced.lineItems, { ...forged, id: 'my-discount' }] } }), { code: 'quote_draft_composite_price_changed' });
  await assert.rejects(save(fixture(ON), estimator, q, { sale: { apply: true, amountCents: 99999 } }), { code: 'winter_sale_request_invalid' });
});

test('send checks it again: the booked job date must be in the window, the amount current and the margin still above the floor', async () => {
  const f = fixture(ON), q = quote(BIG), saved = await save(f, estimator, q, { sale: { apply: true } }), jobId = saved.job.id;
  const preview = (r = readers()) => previewQuoteSend(f.store, estimator, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env: ON, compositeState: async () => q.state, winterSale: r });
  await assert.rejects(preview(), { code: 'quote_draft_winter_sale_ineligible', details: { code: 'job_date_needed' } });
  f.job(jobId).date = '2027-03-02';
  await assert.rejects(preview(), { code: 'quote_draft_winter_sale_ineligible', details: { code: 'job_date_outside' } });
  f.job(jobId).date = '2026-12-14';
  await assert.rejects(preview(readers(HIGH_COSTS)), { code: 'quote_draft_winter_sale_ineligible', details: { code: 'below_floor' } });
  await assert.rejects(preview(readers(LOW_COSTS, { ...WINTER_SALE_DEFAULTS, amountCents: 50000 })), { code: 'quote_draft_winter_sale_ineligible', details: { code: 'amount_changed' } });
  await assert.rejects(previewQuoteSend(f.store, estimator, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env: OFF, compositeState: async () => q.state, winterSale: readers() }), { code: 'quote_draft_winter_sale_disabled' });
  const ok = await preview();
  // The 25% deposit is taken from the discounted total (quote-payment-policy.js, unchanged split).
  assert.match(ok.summary, new RegExp((q.priced.totalCents - 40000) / 100 >= 1000 ? `\\$${((q.priced.totalCents - 40000) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''));
  const sent = await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: readers() });
  const estimate = f.job(jobId).estimate;
  assert.equal(sent.job.estimate.status, 'sent');
  assert.equal(estimate.depositRequiredCents, Math.round((q.priced.totalCents - 40000) * 0.25));
  assert.equal(estimate.paymentSchedule.depositCents + estimate.paymentSchedule.remainderCents, q.priced.totalCents - 40000);
});

test('a sale quote owner-overridden on margin keeps the override at send, but never on the date terms', async () => {
  const f = fixture(ON), q = quote(BIG), saved = await save(f, owner, q, { sale: { apply: true, override: { reason: 'Owner call' } }, sale_readers: readers(HIGH_COSTS) }), jobId = saved.job.id;
  f.job(jobId).date = '2026-12-14';
  const preview = await previewQuoteSend(f.store, owner, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env: ON, compositeState: async () => q.state, winterSale: readers(HIGH_COSTS) });
  assert.ok(preview.confirmToken);
  f.job(jobId).date = '2027-04-01';
  await assert.rejects(previewQuoteSend(f.store, owner, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env: ON, compositeState: async () => q.state, winterSale: readers(HIGH_COSTS) }), { details: { code: 'job_date_outside' } });
});

test('a re-save without the sale removes the line and its record', async () => {
  const f = fixture(ON), q = quote(BIG), first = await save(f, estimator, q, { sale: { apply: true } });
  const again = await save(f, estimator, q, { jobId: first.job.id });
  assert.equal(f.job(first.job.id).estimate.lineItems.some(line => line.id === WINTER_SALE_LINE_ID), false);
  assert.equal(f.job(first.job.id).estimate.amountCents, q.priced.totalCents);
  assert.equal(f.job(first.job.id).quoteDraft.winterSale, null);
  assert.equal(Object.hasOwn(again.job, 'winterSale'), false);
});

test('flag off: the request field is refused exactly like any other unsupported draft field, and nothing else changes', async () => {
  const q = quote(BIG);
  const asField = await save(fixture(OFF), estimator, q, { env: OFF, sale: { apply: true } }).catch(error => [error.code, error.status, error.message]);
  const unknown = await save(fixture(OFF), estimator, q, { env: OFF, extra: { surprise: true } }).catch(error => [error.code, error.status, error.message]);
  assert.deepEqual(asField, unknown);
  // Without the field, a flag-off save reads nothing of the sale and saves exactly what it did before.
  const never = { settings: async () => { throw new Error('never read'); }, costs: async () => { throw new Error('never read'); }, setter: async () => { throw new Error('never read'); } };
  const f = fixture(OFF), saved = await save(f, estimator, q, { env: OFF, sale_readers: never });
  assert.equal(Object.hasOwn(f.job(saved.job.id).quoteDraft, 'winterSale'), false);
  assert.equal(Object.hasOwn(saved.job, 'winterSale'), false);
  // A flag-on save that does not ask for the sale reads nothing either and saves the same quote.
  const g = fixture(ON), plain = await save(g, estimator, q, { sale_readers: never });
  assert.equal(g.job(plain.job.id).estimate.amountCents, f.job(saved.job.id).estimate.amountCents);
});

test('the customer portal shows the sale line and refuses an approval once the job moved outside the window', async t => {
  const f = fixture(ON), q = quote(BIG), saved = await save(f, estimator, q, { sale: { apply: true } }), id = saved.job.id;
  f.job(id).date = '2026-12-14';
  const ok = await previewQuoteSend(f.store, estimator, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ON, compositeState: async () => q.state, winterSale: readers() });
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: readers() });
  const job = structuredClone(f.job(id)), env = { ...portalEnv, EGC_WINTER_SALE: 'true' };
  const store = portalStore(t, { [id]: { ...job, date: '2027-03-10' } });
  const handlers = portalHandlers(NOW), cookie = await portalCookie(id, {}, Date.parse(NOW)), view = await portalView(handlers, cookie, env), shown = view.body.estimate;
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const line = shown.lineItems.find(row => row.name === 'Early-bird winter sale');
  assert.ok(line, 'the customer sees the sale as its own line');
  const approve = { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, request_id: randomUUID() };
  const refused = await portalPost(handlers, cookie, approve, env);
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_SALE_DATE']);
  // Back inside the window, the same approval goes through on the discounted total.
  store.edit(id, { date: '2026-12-14' });
  const approved = await portalPost(handlers, cookie, { ...approve, request_id: randomUUID() }, env);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

test('the owner edits the sale settings through Job actuals: validated, audited, and refused to anyone else', async () => {
  const rows = new Map(), writes = [];
  const store = { read: async (collection, docId) => structuredClone(rows.get(`${collection}/${docId}`) || null), commit: async list => { for (const write of list) { writes.push(write); rows.set(`${write.collection}/${write.id}`, { ...structuredClone(write.patch), revision: `r${writes.length}` }); } } };
  assert.deepEqual(await readWinterSaleSettings(store), { revision: null, updatedAt: null, updatedBy: null, ...WINTER_SALE_DEFAULTS });
  const body = { action: 'winter_sale.settings.set', requestId: randomUUID(), expectedRevision: null, settings: { ...WINTER_SALE_DEFAULTS, amountCents: 30000, junkManHoursPerLoad: 1.5 } };
  await assert.rejects(mutateWinterSaleSettings(store, estimator, body), { status: 403 });
  await assert.rejects(mutateWinterSaleSettings(store, owner, { ...body, settings: { ...body.settings, jobFrom: '2027-03-01' } }), { code: 'winter_sale_settings_invalid' });
  const result = await mutateWinterSaleSettings(store, owner, body, NOW);
  assert.deepEqual([result.settings.amountCents, result.settings.junkManHoursPerLoad], [30000, 1.5]);
  assert.ok(writes.some(write => write.collection === HUB_AUDIT_COLLECTION && write.patch.action === 'winter_sale.settings.set' && write.patch.visibility === 'owner'));
  assert.equal((await mutateWinterSaleSettings(store, owner, body, NOW)).replayed, true);
  // The API: only with the flag on, and the GET shows them beside the cost settings.
  const handlers = jobActualsHandlers({ session: async () => owner, saleStore: () => store, settingsStore: () => ({ read: async () => null, commit: async () => {} }), dispatch: () => ({ datedJobs: async () => [] }), knock: () => ({ getMany: async () => new Map() }), timecards: async () => [], now: () => new Date(NOW) });
  const get = async env => (await handlers.get({ env, request: new Request('https://easygaragecleaning.com/api/job-actuals') })).json();
  assert.equal((await get(ON)).winterSale.settings.amountCents, 30000);
  assert.equal(Object.hasOwn(await get(OFF), 'winterSale'), false);
});
