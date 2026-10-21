// Review fixes for the D12 Labor line (owner, 2026-10-18: "We have to price man hours estimated to do the job. It's $40
// an hour."; the owner set the rate to $53.00 per man-hour on 2026-10-19). One focused regression test per confirmed finding (money-1..5, flow-1..8). Synthetic data only
// (tests/helpers/estimator-fixture.mjs); nothing here reaches HighLevel, Firebase or production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { INSTALLATION_ID, LABOR_ID, compositeApproval, laborEstimate, menuPrices, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { laborBreakdownItem, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { walkthroughCrewBrief } from '../functions/_lib/walkthrough-crew-brief.js';
import { suggestedDuration } from '../functions/_lib/dispatch-duration.js';
import { NOW, ON_ENV, builderState, client, estimator, fixture, menu, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

// Every menu price approved at its current amount: only the labor and installation rules can block a send.
const allApproved = (extra = {}) => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState(prices, extra); };
const TRUCK = menuItem('Full truck load'), BASE = menuItem('Two-car garage base'), MATTRESS = menuItem('Mattress');
const pick = (item, quantity = 1) => ({ id: item.id, quantity });
const products = group => menu.products.filter(item => item.group === group);
const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
const handoff = (n, quote, { logistics = {}, scope = null, ...extra } = {}) => {
  const plan = signedPlan(n, { quote, total: quote.total, logistics, ...(quote.estimated_duration_min ? { minutes: quote.estimated_duration_min } : {}) });
  if (scope) plan.scope = { ...plan.scope, ...scope };
  return { actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, ...extra, plan };
};
const signedQuote = priced => ({ composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 });

// money-2 / flow-1: the pre-fill is person-minutes of the work, never crew size x the schedule's wall-clock estimate
// (divided by the crew, rounded to 30 minutes and clamped to 120..540 minutes).
test('money-2 / flow-1: the man-hours estimate is the same for any crew and is never capped at one working day', async () => {
  const state = builderState();
  const est = (removal, fullness, goods = {}) => priceCompositeQuote(state, selection({ removal, shelving: goods.shelving || [], storage: goods.storage || [], labor: { manHours: null, fullness } }), { complete: true }).labor.manHours;
  // A two-car base in a light garage: 2 x (60 + 0) = 120 person-minutes = 2 man-hours (the review's real person-time); a
  // half load adds nothing: its own price pays its loading and hauling (D-JUNK).
  assert.equal(est([pick(BASE), pick(menuItem('Half load'))], 'light'), 2);
  // Packed: 2 x (60 + 120) = 360 = 6 man-hours, with 5 truck loads or none.
  assert.equal(est([pick(BASE), pick(TRUCK, 5)], 'packed'), 6);
  assert.equal(est([pick(BASE)], 'packed'), 6);
  // With 6 metal shelving units the shelving adds its hour each (the old pre-fill absorbed them at the 540-minute cap).
  const metal = products('shelving').find(item => /steel|metal/i.test(item.name));
  assert.equal(est([pick(BASE), pick(TRUCK, 5)], 'packed', { shelving: [pick(metal, 6)] }), 12);
  // A two-day job: 20 shelving units in a packed garage is 360 + 20 x 60 = 1560 person-minutes = 26 man-hours, not one 9-hour day.
  assert.equal(est([pick(BASE)], 'packed', { shelving: [pick(metal, 20)] }), 26);
  // The signed handoff books the same man-hours whatever crew and minutes the Schedule tab sends.
  const priced = priceCompositeQuote(state, selection({ labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const book = async (crew, minutes) => {
    const f = fixture(), result = await saveWalkthroughHandoff(f.store, owner, handoff(1, { ...signedQuote(priced), estimated_duration_min: minutes }, { logistics: { crew_size: crew } }), NOW, { env: ON_ENV, compositeState: async () => state });
    return f.job(result.job.id).compositeQuote.breakdown.labor;
  };
  for (const [crew, minutes] of [[1, 540], [2, 180], [3, 120], [4, 120]]) {
    const labor = await book(crew, minutes);
    assert.deepEqual([labor.manHours, labor.prefilledManHours, labor.adjusted, labor.belowEstimate], [6, 6, false, false], `crew of ${crew}, ${minutes} minutes`);
  }
});

// money-1 / flow-2: the estimate includes the install time of the goods the builder sells, never the truck loads (D-JUNK:
// their price pays loading, hauling and disposal); goods it cannot time keep a send block until the estimator sets the
// man-hours by hand or the owner answers.
test('money-1 / flow-2: goods move the estimate and truck loads never do; goods it cannot time block the send until a human sets the man-hours', () => {
  const state = allApproved(), base = [pick(BASE), pick(TRUCK)];
  const price = (removal, goods, labor = { manHours: null, fullness: 'medium' }, s = state) => priceCompositeQuote(s, selection({ removal, shelving: goods.shelving || [], storage: goods.storage || [], labor }), { complete: true });
  const none = price(base, {});
  assert.deepEqual([none.labor.manHours, none.approval.ready], [3, true], '2 x (60 + 30) = 180 person-minutes; the truck load adds none');
  // Shelving units and totes carry the walkthrough's install minutes (2 x 30 per unit, 2 x 4 per tote).
  const shelf = products('shelving')[0], totes = menu.products.find(item => item.id === 'hd-341048322');
  const timed = price(base, { shelving: [pick(shelf, 6)], storage: [pick(totes, 2)] });
  assert.deepEqual([timed.labor.estimate.installPersonMinutes, timed.labor.manHours, timed.approval.ready], [6 * 60 + 2 * 4 * 8, 10, true]);
  // Three truck loads, a mattress and the stairs leave the estimate where one load put it: their prices pay that time.
  assert.equal(price([pick(BASE), pick(TRUCK, 3), pick(MATTRESS, 2), pick(menuItem('Stairs'))], {}).labor.manHours, 3);
  // The review's case: 10 shelving units, overhead racks, cabinets and track rails. Shelving is timed; the rest is named
  // and the send waits; the customer line still says installation is in the labor.
  const goods = { shelving: [pick(shelf, 10)], storage: [pick(products('overhead')[0], 4), pick(products('cabinets-workbenches')[0], 6), pick(products('track-systems')[0], 12)] };
  const prefilled = price(base, goods);
  assert.equal(prefilled.labor.estimate.installPersonMinutes, 600);
  assert.deepEqual(prefilled.labor.estimate.installNotEstimated.map(row => [row.id, row.packs]), goods.storage.map(row => [row.id, row.quantity]));
  assert.deepEqual(prefilled.approval.blocked.map(row => row.id), [INSTALLATION_ID]);
  assert.match(prefilled.approval.blocked[0].reason, /The labor estimate has no install time for .+, so the pre-filled man-hours do not include installing them\. Adjust the man-hours/);
  // Half a man-hour kept as if pre-filled (not adjusted) still waits; the estimator's own number sends, flagged below the estimate.
  assert.equal(price(base, goods, { manHours: 0.5, fullness: 'medium' }).approval.ready, false);
  const byHand = price(base, goods, { manHours: 40, adjusted: true, fullness: 'medium' });
  assert.deepEqual([byHand.approval.ready, byHand.labor.adjusted, byHand.labor.belowEstimate], [true, true, false]);
  const cut = price(base, goods, { manHours: 0.5, adjusted: true, fullness: 'medium' });
  assert.deepEqual([cut.approval.ready, cut.labor.belowEstimate, cut.labor.prefilledManHours], [true, true, prefilled.labor.manHours], 'the owner sees the estimate the man-hours were cut from');
  // The owner's answer (installation included in the goods price) clears it for every quote.
  assert.equal(price(base, goods, undefined, allApproved({ goodsInstallationIncluded: true })).approval.ready, true);
  // The saved breakdown keeps the block at send time too.
  assert.deepEqual(compositeApproval(prefilled.breakdown, state).blocked.map(row => row.id), [INSTALLATION_ID]);
  assert.deepEqual(compositeApproval(byHand.breakdown, state), { ready: true, blocked: [] });
});

// money-3: the basis of the pre-fill and of "adjusted" is the server's: a browser time estimate is refused, the signed
// handoff reads the signed plan's fullness, and labor below the estimate is recorded however it was sent.
test('money-3: the handoff derives the estimate from the selection and the signed plan; stale or cut labor is recorded against it', async () => {
  const state = builderState();
  assert.throws(() => priceCompositeQuote(state, selection({ labor: { manHours: 2, estimate: { crewSize: 1, onSiteMinutes: 120 } } }), { complete: true }), { code: 'quote_draft_composite_invalid_labor' }, 'no browser estimate is accepted');
  // Priced as a light garage, signed on a plan that says packed: the server's estimate is packed.
  const priced = priceCompositeQuote(state, selection({ labor: { manHours: null, fullness: 'light' } }), { complete: true });
  assert.equal(priced.labor.manHours, 5, '2 x (60 + 0) + 184 install = 304 person-minutes, 5 to the nearest quarter hour');
  const f = fixture(), result = await saveWalkthroughHandoff(f.store, owner, handoff(1, { ...signedQuote(priced), estimated_duration_min: 480 }, { logistics: { crew_size: 4 }, scope: { fullness: 'Packed' } }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(result.job.id), labor = job.compositeQuote.breakdown.labor;
  assert.deepEqual([job.compositeQuote.compositePricing.labor, labor.estimate.fullness, labor.manHours, labor.prefilledManHours, labor.adjusted, labor.belowEstimate],
    [{ manHours: 5, adjusted: false, fullness: 'packed' }, 'packed', 5, 9, false, true], 'the signed price stands; the record shows it is below the estimate for the signed scope');
  assert.equal(job.total, priced.totalCents / 100);
  assert.deepEqual(job.jobBreakdown.sections.at(-1).items, ['5 man-hours sold (below the estimate of 9 man-hours)']);
  // A crafted quote: 2 man-hours, "not adjusted", on a 32-man-hour schedule. It books, flagged against the server's estimate.
  const tiny = priceCompositeQuote(state, selection({ labor: { manHours: 2, fullness: 'medium' } }), { complete: true });
  const g = fixture(), crafted = await saveWalkthroughHandoff(g.store, owner, handoff(1, { ...signedQuote(tiny), estimated_duration_min: 480 }, { logistics: { crew_size: 4 } }), NOW, { env: ON_ENV, compositeState: async () => state });
  const flagged = g.job(crafted.job.id);
  assert.deepEqual([flagged.compositeQuote.breakdown.labor.prefilledManHours, flagged.compositeQuote.breakdown.labor.belowEstimate], [6, true]);
  assert.match(walkthroughCrewBrief(flagged.jobInstructions).find(row => row.label === 'Job breakdown').text, /Labor: 2 man-hours sold \(below the estimate of 6 man-hours\)/);
});

// flow-3: only the man-hours of the labor are terms the customer reviewed.
test('flow-3: re-saving a sent, approved builder quote with only the estimate inputs changed is not a material revision', async () => {
  const state = builderState(), f = fixture(), options = { env: ON_ENV, compositeState: async () => state };
  const first = priceCompositeQuote(state, selection({ labor: { manHours: 6, fullness: 'medium' } }), { complete: true });
  const input = (pricing, lines, extra = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', ...extra,
    draft: { client: client(1), title: 'Garage reset', scope: 'Reset.', line_items: lines, valid_until: '2026-10-30', catalog_version: first.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: pricing } });
  const saved = await saveQuoteDraft(f.store, estimator, input(first.compositePricing, first.lineItems), NOW, options);
  // Sent, and approved by the customer.
  const row = f.rows.get(`jobs/${saved.job.id}`);
  Object.assign(row.estimate, { status: 'sent', sentRevision: 1, sentAt: NOW });
  row.customerApproval = { status: 'approved', approvedAt: NOW, amount: first.totalCents / 100 };
  // The walkthrough now says packed and the crew changed: same man-hours, same lines, same total.
  const again = priceCompositeQuote(state, selection({ labor: { manHours: 6, fullness: 'packed' } }), { complete: true });
  assert.deepEqual(again.lineItems, first.lineItems);
  const job = f.rows.get(`jobs/${saved.job.id}`);
  const resaved = await saveQuoteDraft(f.store, estimator, { ...input(again.compositePricing, again.lineItems, { jobId: job.id, expectedRevision: job.revision }), draft: { ...input(again.compositePricing, again.lineItems).draft, crew_size: 3, estimated_duration_min: 120 } }, NOW, options);
  const after = f.job(saved.job.id);
  assert.deepEqual([after.estimate.revision, after.estimate.status, after.customerApproval.status, resaved.warnings.map(warning => warning.code)], [1, 'sent', 'approved', []]);
  assert.equal(after.quoteDraft.compositePricing.labor.fullness, 'packed', 'the new estimate input is still saved');
  // Changed man-hours are a material revision, as before.
  const more = priceCompositeQuote(state, selection({ labor: { manHours: 7, adjusted: true, fullness: 'packed' } }), { complete: true });
  await saveQuoteDraft(f.store, estimator, input(more.compositePricing, more.lineItems, { jobId: after.id, expectedRevision: after.revision }), NOW, options);
  const material = f.job(saved.job.id);
  assert.deepEqual([material.estimate.revision, material.estimate.status, material.customerApproval.status], [2, 'draft', 'superseded']);
});

// money-5 / flow-4: a job the customer signed before builder quotes had a Labor line keeps its signed price when it is
// revised with that same selection; a new or changed selection needs its Labor line.
test('money-5 / flow-4: a job signed before the Labor line is revised at its signed total; a changed selection needs labor', async () => {
  const state = allApproved({ goodsInstallationIncluded: true }), f = fixture();
  const priced = priceCompositeQuote(state, selection(), { complete: true });
  const signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced)), NOW, { env: ON_ENV, compositeState: async () => state });
  // Rewrite it as the 29ae752 code signed it: the same selection without labor, its breakdown and total without labor.
  const legacy = priceCompositeQuote(state, selection({ labor: null }), { complete: true, requireLabor: false });
  assert.equal(legacy.labor, null);
  const row = f.rows.get(`jobs/${signed.job.id}`);
  Object.assign(row, { total: legacy.totalCents / 100, priceQuoted: legacy.totalCents / 100, compositeQuote: { ...row.compositeQuote, compositePricing: legacy.compositePricing, breakdown: legacy.breakdown } });
  Object.assign(row.estimate, { amount: legacy.totalCents / 100, lineItems: legacy.storedLineItems });
  const revise = async (quote, notes) => { const job = f.rows.get(`jobs/${signed.job.id}`); const input = handoff(1, quote, { jobId: job.id, expectedRevision: job.revision, sourceRevision: f.rows.get('jobs/w1').revision }); input.plan.logistics.notes = notes; return saveWalkthroughHandoff(f.store, owner, input, NOW, { env: ON_ENV, compositeState: async () => state }); };
  // Notes only, with no selection sent, and with the signed selection re-sent: both keep the signed total.
  const noted = await revise({ total: legacy.totalCents / 100 }, 'Gate code 1234');
  assert.equal(noted.ok, true);
  const resent = await revise({ composite_pricing: legacy.compositePricing, total: legacy.totalCents / 100 }, 'Gate code 5678');
  assert.equal(resent.ok, true);
  const job = f.job(signed.job.id);
  assert.deepEqual([job.total, job.compositeQuote.breakdown.labor, job.logistics.notes], [legacy.totalCents / 100, undefined, 'Gate code 5678']);
  // A changed selection (one more mattress) is a new quote: it needs its Labor line.
  const changed = { ...legacy.compositePricing, removal: [...legacy.compositePricing.removal, pick(MATTRESS)] };
  await assert.rejects(revise({ composite_pricing: changed, total: legacy.totalCents / 100 + 70 }, 'x'), { code: 'quote_draft_composite_labor_required' });
});

// flow-8: the crew brief shows one on-site duration; the man-hours are the time sold.
test('flow-8: adjusted man-hours read as time sold next to the estimate, never as a second on-site duration', async () => {
  assert.equal(laborBreakdownItem({ manHours: 6, prefilledManHours: 6 }), '6 man-hours sold');
  assert.equal(laborBreakdownItem({ manHours: 12, prefilledManHours: 9 }), '12 man-hours sold (above the estimate of 9 man-hours)');
  assert.equal(laborBreakdownItem({ manHours: 1, prefilledManHours: null }), '1 man-hour sold');
  const state = builderState(), priced = priceCompositeQuote(state, selection({ labor: { manHours: 12, adjusted: true, fullness: 'medium' } }), { complete: true });
  const f = fixture(), result = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced)), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(result.job.id), brief = walkthroughCrewBrief(job.jobInstructions);
  const breakdown = brief.find(row => row.label === 'Job breakdown').text;
  assert.match(breakdown, /\nLabor: 12 man-hours sold \(above the estimate of 6 man-hours\)$/);
  assert.doesNotMatch(JSON.stringify(brief), /hours on site for a crew/, 'no second on-site duration');
  assert.deepEqual(brief.filter(row => ['Estimated on-site minutes', 'Man-hours sold'].includes(row.label)).map(row => row.text), ['180', '12 man-hours']);
  assert.deepEqual([suggestedDuration(job).minutes, job.estimatedDurationMin], [180, 180], 'the booked time is still the time estimate');
  assert.doesNotMatch(JSON.stringify([job.jobBreakdown, job.jobInstructions]), /\$\s?\d|rateCents/, 'never a price');
});

// The estimate of a saved selection, independent of the price: the server function on its own.
test('laborEstimate: the time model in person-minutes, null without it', () => {
  const state = builderState(), sel = selection({ labor: { manHours: null, fullness: 'full' } });
  // D-JUNK: the base's set-up and sweep-out and its full garage's sorting count; the truck load does not.
  assert.deepEqual(laborEstimate(sel, state), { personMinutes: 2 * (60 + 60) + 2 * 60 + 2 * 32, removalPersonMinutes: 240, installPersonMinutes: 184, fullness: 'full', installNotEstimated: [], manHours: 7 });
  assert.equal(laborEstimate(sel, { ...state, walkthrough: { ...state.walkthrough, minutes: undefined } }), null);
  // A goods-only quote has the base (arrival and set-up) and the install time, no removal or fullness.
  const goodsOnly = laborEstimate(selection({ removal: [], labor: { manHours: null, fullness: 'packed' } }), state);
  assert.deepEqual([goodsOnly.removalPersonMinutes, goodsOnly.installPersonMinutes], [120, 184]);
  assert.equal(LABOR_ID, 'labor');
});

// flow-4 (gameplan): a builder quote saved before the Labor line is refused at signature unless it is the job's own
// signed selection, so the walkthrough warns before the customer signs it.
test('flow-4: the gameplan warns on the review screen when the builder quote it would sign has no Labor line', () => {
  const html = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  const card = html.slice(html.indexOf('Quote builder total'), html.indexOf('Recommended flat rate'));
  assert.match(card, /\$\{gate\?`<p class="required" role="status" id="builder-gate-note">\$\{esc\(builderGateText\(gate\)\)\}<\/p>`:S\.builderQuote\.compositePricing\.labor\|\|builderJunkOnly\(\)\?'':'<p class="required" role="status" id="builder-no-labor">This builder quote has no Labor line: it was saved before builder quotes charged labor\. Open Send options for review, check the man-hours on the review step and save it again before the customer signs\./);
  assert.match(html, /<script src="\/crew\/quote-draft\.js\?v=20261021portaltruck" defer><\/script>/, 'the changed builder script has a new version');
  // D-JUNK: a junk-only builder quote has no Labor line by design, so the warning is not shown for it. D-LABOR-TEXT: the
  // homeowner signing on this page sees the builder's Labor line as one amount, even on a quote saved when it named the
  // man-hours (Review stops before the signature until the quote is built again: builderSignGate 'stale', as the server
  // refuses it, builderMismatch). builderJunkOnly leaves a Labor line out of its test, so a junk-only quote saved with one
  // is recognized as stale.
  const fn = name => { const start = html.indexOf(`function ${name}(`); return html.slice(start, html.indexOf('\n', start)); };
  const page = { S: {}, esc: value => String(value), signedLines: () => [] };
  vm.runInNewContext(`${fn('builderJunkOnly')}\n${fn('quoteLinesMarkup')}\nthis.builderJunkOnly = builderJunkOnly; this.quoteLinesMarkup = quoteLinesMarkup;`, page);
  const line = (id, kind, name, totalCents) => ({ id, kind, name, description: '', quantity: 1, unitCents: totalCents, totalCents });
  page.S.builderQuote = { compositePricing: {}, totalCents: 75000, lineItems: [line('removal-junk-full', 'service', 'Junk removal: full truck load', 75000)] };
  assert.equal(page.builderJunkOnly(), true);
  page.S.builderQuote = { compositePricing: { labor: { manHours: 6 } }, totalCents: 99000, lineItems: [line('removal-junk-full', 'service', 'Junk removal: full truck load', 75000), line('labor', 'labor', 'Labor: 6 man-hours × $40.00', 24000)] };
  assert.equal(page.builderJunkOnly(), true, 'junk-only apart from its Labor line');
  assert.equal(page.quoteLinesMarkup(990), '<span class="quote-line"><span>Junk removal: full truck load</span><b>$750.00</b></span><span class="quote-line"><span>Labor</span><b>$240.00</b></span>');
  page.S.builderQuote.lineItems.push(line('removal-base', 'service', 'Two-car garage base', 97500));
  assert.equal(page.builderJunkOnly(), false, 'a cleaning base is garage work');
});
