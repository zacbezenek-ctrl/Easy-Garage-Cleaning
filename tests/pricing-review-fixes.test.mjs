// Review fixes for the owner decisions of 2026-10-18 (D-JUNK, D-LABOR-TEXT, D-DEPOSIT, D-SIGN). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { builderMenu, compositeScope, junkOnly, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { customerScopeText, staleBuilderQuote, unsentQuoteDraft } from '../functions/_lib/quote-model.js';
import { saveWalkthroughHandoff, walkthroughGarageWork } from '../functions/_lib/walkthrough-handoff.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { publicQuotePaymentSchedule, quotePaymentSummary, scheduleSplit } from '../functions/_lib/quote-payment-policy.js';
import { staleBuilderQuoteReport } from '../scripts/stale-builder-quotes.mjs';
import { portalCookie, portalHandlers, portalPost, portalStore, portalView } from './helpers/portal-fixture.mjs';
import { NOW, ON_ENV, SHELF, builderState, fixture, menu, menuItem, owner, signedPlan } from './helpers/estimator-fixture.mjs';

const state = builderState(), id = name => menuItem(name).id;
const descriptor = (removal, { shelving = [], storage = [], labor } = {}) => ({ menuVersion: menu.menuVersion, settingsVersion: state.settings.settingsVersion, steps: ['removal', 'shelving', 'storage'], removal, shelving, storage, ...(labor ? { labor } : {}) });
const quoteOf = priced => ({ line_items: priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents })), catalog_version: priced.menuVersion, composite_pricing: priced.compositePricing });
const sign = async (f, priced, scope = {}, extra = {}) => {
  const plan = signedPlan(1, { total: priced.totalCents / 100, quote: quoteOf(priced) });
  plan.scope = { ...plan.scope, ...scope };
  return saveWalkthroughHandoff(f.store, owner, { actorId: owner.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan, ...extra }, NOW, { env: ON_ENV, compositeState: async () => state });
};

// D-JUNK: special items ("incremental disposal/handling") and access charges ("incremental labor only") are priced on top
// of a truck on the job, so a quote of only those is not junk-only: it keeps its Labor line (the set-up and sweep-out).
test('a quote of special items or access charges alone is not junk-only: it needs its Labor line', () => {
  for (const removal of [[{ id: id('Mattress'), quantity: 1 }], [{ id: id('Hot tub dismantle and haul'), quantity: 1 }], [{ id: id('Stairs'), quantity: 1 }], [{ id: id('Piano / safe'), quantity: 1 }, { id: id('Stairs'), quantity: 1 }]]) {
    assert.throws(() => priceCompositeQuote(state, descriptor(removal), { complete: true }), error => error.code === 'quote_draft_composite_labor_required', JSON.stringify(removal));
    const priced = priceCompositeQuote(state, descriptor(removal, { labor: { manHours: null, fullness: 'medium' } }), { complete: true });
    assert.equal(priced.junkOnly, false);
    // The estimate is the set-up and sweep-out (2 x 60 person-minutes): never the items' or the access' own minutes.
    // 2 man-hours x $53.00 = $106.00.
    assert.deepEqual([priced.labor.manHours, priced.labor.totalCents, priced.lineItems.at(-1).name], [2, 10600, 'Labor']);
  }
  // With a truck load, the same items are junk removal: $1,000 per truck plus their own prices, no Labor line.
  const truck = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 1 }, { id: id('Mattress'), quantity: 1 }, { id: id('Stairs'), quantity: 1 }], { labor: { manHours: 6, fullness: 'medium' } }), { complete: true });
  assert.deepEqual([truck.junkOnly, truck.labor, truck.lineItems.some(line => line.id === 'labor')], [true, null, false]);
  assert.equal(junkOnly([]), false);
  assert.equal(junkOnly([{ section: 'removal', group: 'special' }]), false);
  assert.equal(junkOnly([{ section: 'removal', group: 'junk' }, { section: 'removal', group: 'access' }]), true);
  // The builder's own copy of the rule agrees.
  const ctx = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
  vm.runInContext(readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8'), ctx);
  const B = ctx.window.EGCQuoteDraft.builder, view = JSON.parse(JSON.stringify(builderMenu(state)));
  const sel = removal => ({ removal, shelving: [], storage: [], labor: { manHours: null, adjusted: false } });
  assert.equal(B.junkOnly(view, sel({ [id('Mattress')]: 1 })), false);
  assert.equal(B.junkOnly(view, sel({ [id('Mattress')]: 1, [id('Quarter load')]: 1 })), true);
  assert.equal(B.runningTotals(view, sel({ [id('Stairs')]: 1 }), 'medium').laborHours, 2);
});

// The customer signs and reads exactly what is priced: a builder quote's scope is its lines (compositeScope), the same
// text a sent builder quote saves (crew/quote-draft.js builderScope), and a junk-only one says it is junk removal only.
test('a signed builder quote saves its priced scope, never the walkthrough Finish step\'s', async () => {
  const ctx = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
  vm.runInContext(readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8'), ctx);
  const junk = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 2 }, { id: id('Mattress'), quantity: 1 }]), { complete: true });
  const garage = priceCompositeQuote(state, descriptor([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 1 }], { shelving: [{ id: SHELF.id, quantity: 2 }], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  assert.equal(compositeScope(junk), 'Junk removal only: Full truck load × 2; Mattress. Loading, hauling and disposal; no sorting, organizing or reset.');
  assert.match(compositeScope(garage), /^Removal \/ cleanout: Two-car garage base; Full truck load\. Shelving: .+ × 2\. Labor\.$/);
  for (const priced of [junk, garage]) assert.equal(ctx.window.EGCQuoteDraft.builder.builderScope(JSON.parse(JSON.stringify(priced))), compositeScope(priced), 'the sent quote and the signed one read the same');
  // Signed on a walkthrough whose Finish step sold cleanout and three shelving units: the estimate reads the priced lines.
  const f = fixture(), signedJunk = await sign(f, junk, { sort_method: 'remove_all', finish: ['cleanout'] });
  assert.equal(f.job(signedJunk.job.id).estimate.scope, compositeScope(junk));
  const g = fixture(), signedGarage = await sign(g, garage, { sort_method: 'zones', finish: ['cleanout', 'shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 3 } });
  assert.equal(g.job(signedGarage.job.id).estimate.scope, compositeScope(garage));
  assert.doesNotMatch(g.job(signedGarage.job.id).estimate.scope, /3 metal shelving units|Garage cleanout and reset/);
});

// Review blocker: the default walkthrough (Cleanout + reset with a truck load) builds as truck loads only, a junk-only
// quote. It prices no garage work, so it is signed only on a walkthrough that records none; otherwise nothing is saved.
test('a junk-only builder quote is refused on a walkthrough that records garage work, and signed on one that does not', async () => {
  const junk = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 1 }]), { complete: true });
  for (const [scope, named] of [[{ sort_method: 'zones' }, 'sorting into keep / donate / haul zones and resetting what stays'], [{ sort_method: 'customer' }, 'sorting with the customer and resetting what stays'],
    [{ sort_method: 'labels', finish: ['cleanout', 'shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 3 } }, '3 shelving units'], [{ sort_method: 'remove_all', finish: ['cleanout', 'deep_clean'] }, 'a deep clean'],
    [{ sort_method: 'remove_all', hazards: ['Pest waste'] }, 'pest-waste cleanup']]) {
    const f = fixture();
    await assert.rejects(sign(f, junk, scope), error => error.code === 'handoff_builder_junk_only_garage_work' && error.status === 409 && error.message.includes(named) && /Nothing was saved/.test(error.message), JSON.stringify(scope));
    assert.equal(f.calls.length, 0, 'nothing is saved');
  }
  for (const sort_method of ['remove_all', 'labels', undefined]) {
    const f = fixture(), saved = await sign(f, junk, { ...(sort_method ? { sort_method } : {}), finish: ['cleanout'] }), job = f.job(saved.job.id);
    assert.deepEqual([job.total, job.estimate.lineItems.map(line => line.id), job.compositeQuote.breakdown.labor], [1000, ['removal-junk-full'], undefined], String(sort_method));
  }
  assert.deepEqual(walkthroughGarageWork({ sort_method: 'zones', finish: ['cleanout', 'pressure_wash', 'mouse_trapping', 'shelving', 'totes'], finish_details: { shelf_qty: 1, tote_qty: 0 } }),
    ['sorting into keep / donate / haul zones and resetting what stays', 'a pressure wash', 'mouse trapping', '1 shelving unit']);
  // A garage quote prices the sorting with its cleaning base and Labor line: signed on the same walkthrough.
  const garage = priceCompositeQuote(state, descriptor([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 1 }], { labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const f = fixture(), saved = await sign(f, garage, { sort_method: 'zones' });
  assert.equal(f.job(saved.job.id).compositeQuote.breakdown.labor.manHours, 3);
});

// A builder quote sent before the Labor rules of 2026-10-18 (and not approved) is withheld from the customer until the
// office saves it again: its price is not one the owner's rules give. The scope it saved reads "Labor" wherever the
// customer reads an older approved one.
function sentBuilderJob({ status = 'sent', laborVersion, junk = true } = {}) {
  const lines = [{ id: 'egc-026', lineItemId: 'removal-junk-full', section: 'removal', group: 'junk', name: 'Full truck load', qty: 1 }, ...(junk ? [] : [{ id: 'egc-003', lineItemId: 'removal-base', section: 'removal', group: 'cleaning-base', name: 'Two-car garage base', qty: 1 }])];
  return { id: 'job-old', type: 'job', status: 'scheduled', pipelineStatus: 'estimate_sent', customer: 'Synthetic', customerId: 'c1', serviceType: 'Garage transformation', total: 990, priceQuoted: 990,
    quoteDraft: { version: 1, requestId: 'r1', compositePricing: { menuVersion: 'm', settingsVersion: 's', steps: ['removal', 'shelving', 'storage'], removal: [{ id: 'egc-026', quantity: 1 }], shelving: [], storage: [], labor: { manHours: 6, adjusted: false, fullness: 'medium' } },
      breakdown: { version: 1, source: 'composite', lines, sections: [], labor: { ...(laborVersion ? { version: laborVersion } : {}), manHours: 6, rateCents: 4000, totalCents: 24000 } } },
    estimate: { number: 'EST-OLD', revision: 1, sentRevision: 1, status, sentAt: '2026-09-21T15:00:00.000Z', amount: 990, amountCents: 99000, depositRequired: 247.5, depositRequiredCents: 24750, validUntil: '2026-10-30', termsVersion: '2026-09',
      scope: 'Removal / cleanout: Full truck load. Labor: 6 man-hours.',
      lineItems: [{ id: 'removal-junk-full', kind: 'service', name: 'Junk removal: full truck load', description: 'Hauling and disposal by full truck load.', quantity: 1, unitCents: 75000, totalCents: 75000, optional: false, selected: true, taxable: false },
        { id: 'labor', kind: 'labor', name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour.', quantity: 1, unitCents: 24000, totalCents: 24000, optional: false, selected: true, taxable: false }] },
    ...(status === 'approved' ? { customerApproval: { status: 'approved', approvedAt: '2026-09-21T16:00:00.000Z', approvedBy: 'Synthetic' } } : {}),
    deposit: { amount: 247.5, paidAmount: 0, status: 'required' }, quoteStatus: status };
}

test('a builder quote sent before the Labor rules of 2026-10-18 is withheld until it is saved again; an approved one reads "Labor"', async t => {
  assert.equal(staleBuilderQuote(sentBuilderJob()), true, 'junk-only with a Labor line');
  assert.equal(staleBuilderQuote(sentBuilderJob({ junk: false })), true, 'a Labor line priced before the rules');
  assert.equal(staleBuilderQuote(sentBuilderJob({ junk: false, laborVersion: 2 })), false);
  assert.equal(staleBuilderQuote(sentBuilderJob({ status: 'approved' })), false, 'an approved quote keeps what was agreed');
  assert.equal(unsentQuoteDraft(sentBuilderJob()), true);
  portalStore(t, { 'job-old': sentBuilderJob(), 'job-ok': { ...sentBuilderJob({ status: 'approved' }), id: 'job-ok' } });
  const handlers = portalHandlers(), view = await portalView(handlers, await portalCookie('job-old'));
  assert.equal(view.status, 200);
  assert.deepEqual([view.body.estimate.status, view.body.estimate.withheld, view.body.estimate.approvable, view.body.estimate.amount, view.body.estimate.lineItems.length], ['being_updated', true, false, 0, 0]);
  const approve = await portalPost(handlers, await portalCookie('job-old'), { action: 'approve_estimate', signed_name: 'Synthetic', confirmed: true, estimate_revision: 1, amount_cents: 99000, estimate_fingerprint: 'x' });
  assert.equal(approve.status, 409);
  assert.throws(() => moneyDocumentModel(sentBuilderJob(), { kind: 'estimate', now: NOW }), error => error.status === 409 && /being updated/.test(error.message));
  assert.equal(moneyDocumentModel(sentBuilderJob(), { kind: 'estimate', now: NOW, audience: 'staff' }).kind, 'estimate', 'the office still reads it');
  // An approved one keeps its price and lines; the customer reads its Labor line and scope as one word.
  const approved = await portalView(handlers, await portalCookie('job-ok'));
  assert.equal(approved.body.estimate.scope, 'Removal / cleanout: Full truck load. Labor.');
  assert.deepEqual(approved.body.estimate.lineItems.map(line => [line.name, line.description, line.amount]), [['Junk removal: full truck load', 'Hauling and disposal by full truck load.', 750], ['Labor', '', 240]]);
  assert.equal(moneyDocumentModel({ ...sentBuilderJob({ status: 'approved' }) }, { kind: 'estimate', now: NOW }).scope, 'Removal / cleanout: Full truck load. Labor.');
  assert.equal(customerScopeText('Removal / cleanout: Two-car garage base. Shelving: HDX × 1. Labor: 3.5 man-hours.'), 'Removal / cleanout: Two-car garage base. Shelving: HDX × 1. Labor.');
  assert.equal(customerScopeText('Labor: 1 man-hour.'), 'Labor.');
  assert.equal(customerScopeText('Included: Labor: 6 man-hours of sorting, as agreed.'), 'Included: Labor: 6 man-hours of sorting, as agreed.', 'only the builder\'s own part');
  // The office's list (scripts/stale-builder-quotes.mjs): sent ones first, never a name or amount.
  const report = staleBuilderQuoteReport([sentBuilderJob(), { ...sentBuilderJob({ junk: false }), id: 'egc_19705550100', estimate: { ...sentBuilderJob().estimate, status: 'draft' } }, { ...sentBuilderJob({ status: 'approved' }), id: 'job-ok' }, { id: '_egc_lock', recordType: 'lock' }], { now: new Date(NOW), runId: 'run-1' });
  assert.deepEqual(report.quotes, { count: 2, sent: 1, rows: [{ id: 'job-old', estimate: 'EST-OLD', revision: 1, sent: true, reason: 'labor_before_2026_10_18' }, { id: 'egc_…0100', estimate: 'EST-OLD', revision: 1, sent: false, reason: 'labor_before_2026_10_18' }] });
  assert.doesNotMatch(JSON.stringify(report), /Synthetic|990|247/);
});

// The Hub's legacy estimate editor keeps the saved schedule while it writes a new amount and deposit: no customer surface
// then states the saved split next to the new deposit.
test('a saved payment schedule is shown only while it is the estimate\'s own split', async t => {
  const junk = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 2 }]), { complete: true });
  const f = fixture(), saved = await sign(f, junk), job = structuredClone(f.job(saved.job.id));
  assert.deepEqual(publicQuotePaymentSchedule(job.estimate), { depositDueDate: '2026-10-17', remainderDueDate: '2026-10-19', timeZone: 'America/Denver', depositCents: 50000, remainderCents: 150000, policyVersion: '2026-10-deposit25' });
  // employee-suite.js action 'estimate': $1,800 with its 25% deposit, marked sent.
  job.total = 1800; job.priceQuoted = 1800;
  job.estimate = { ...job.estimate, status: 'sent', amount: 1800, lineItems: [{ name: 'Garage transformation', description: job.estimate.scope, quantity: 1, amount: 1800 }], depositRequired: 450, termsVersion: '2026-09', revision: 2 };
  job.deposit = { ...job.deposit, amount: 450, status: 'required' };
  assert.equal(publicQuotePaymentSchedule(job.estimate), null);
  const doc = moneyDocumentModel({ ...job, id: 'job-x' }, { kind: 'estimate', now: NOW });
  assert.deepEqual(doc.rows.map(row => [row.label, row.cents]), [['Total', 180000], ['Deposit due upfront', 45000], ['Payments received', 0], ['Balance due', 180000]]);
  assert.doesNotMatch(doc.terms, /\$500\.00|\$1,500/);
  portalStore(t, { 'job-x': { ...job, id: 'job-x' } });
  const view = await portalView(portalHandlers(), await portalCookie('job-x'));
  assert.deepEqual([view.body.estimate.amount, view.body.estimate.depositRequired, view.body.estimate.paymentSchedule, /\$500\.00|\$1,500/.test(view.body.estimate.terms)], [1800, 450, undefined, false]);
  // Each saved figure must agree: an unreadable or different cents copy fails closed too.
  const signed = f.job(saved.job.id).estimate;
  for (const changed of [{ amountCents: 200001 }, { depositRequiredCents: 50001 }, { depositRequired: 'x' }, { paymentSchedule: { ...signed.paymentSchedule, remainderCents: -1 } }]) assert.equal(publicQuotePaymentSchedule({ ...signed, ...changed }), null, JSON.stringify(changed));
  assert.deepEqual(scheduleSplit({ depositCents: 26393, remainderCents: 79178 }), { depositPct: 25, remainderPct: 75 });
  assert.equal(quotePaymentSummary({ depositCents: 75000, remainderCents: 75000, depositDueDate: '2026-10-17', remainderDueDate: '2026-10-19' }, '2026-10-19'), '50% deposit $750.00 due 2026-10-17; 50% remainder $750.00 due when the job is complete, scheduled for 2026-10-19 (America/Denver).');
});
