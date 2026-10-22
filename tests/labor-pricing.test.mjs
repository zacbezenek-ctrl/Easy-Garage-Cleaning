// D12 (owner, 2026-10-18): "We have to price man hours estimated to do the job. It's $40 an hour." Every builder quote
// with garage work carries a Labor line = the estimated man-hours x the owner's labor rate ($53.00 per man-hour since the
// owner's decision of 2026-10-19, until the owner changes it on Menu prices), on top of the menu lines; the man-hours are pre-filled from the server's own time
// estimate of the selection (laborEstimate, person-minutes) and the estimator may adjust them. The rate is never read from
// the browser, and the signed handoff prices the labor again exactly like every other builder line.
// D-JUNK (owner, 2026-10-18: "$750 per truck covers the crew's time"; $1,000 per truck since 2026-10-21): the estimate never counts truck-load, hauling or
// disposal time, and a junk-only quote has no Labor line at all. D-LABOR-TEXT: the customer sees the Labor line as one
// amount, "Labor"; the staff keep the man-hours. Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LABOR_RATE_CENTS, approvalRefusal, HAULING_GROUPS, LABOR_ID, LABOR_MAN_HOURS, compositeApproval, junkOnly, laborEstimate, laborRate, laborTotalCents, manHoursOf, menuPrices, priceCompositeQuote, validManHours } from '../functions/_lib/composite-quote.js';
import { builderLaborLine, customerLaborLine, estimateChanged } from '../functions/_lib/quote-model.js';
import { invoiceLineItems } from '../functions/_lib/money-core.js';
import { moneyProjection } from '../functions/_lib/money-service.js';
import { moneyDocumentModel, renderMoneyDocument } from '../functions/_lib/money-document.js';
import { walkthroughCrewBrief } from '../functions/_lib/walkthrough-crew-brief.js';
import { scheduleMirrorNote } from '../functions/_lib/ghl-schedule-mirror.js';
import { portalCookie, portalHandlers, portalStore, portalView } from './helpers/portal-fixture.mjs';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { releaseHandoffPrices, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { signedGarageWork } from '../functions/_lib/knock-setters.js';
import { suggestedDuration } from '../functions/_lib/dispatch-duration.js';
import { BASE_ENV, ESTIMATE_MAN_HOURS, LABOR, LABOR_CENTS, LATER, MON, NOW, ON_ENV, SHELF, builderState, client, estimator, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
const handoff = (n, quote, extra = {}) => ({ actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, ...extra, plan: signedPlan(n, { quote, ...(quote.total ? { total: quote.total } : {}) }) });

test('the labor math: $53.00 by default, man-hours 0.5 to 200 in quarter hours, person-minutes to the nearest quarter hour, totals round half up to the cent', () => {
  assert.equal(DEFAULT_LABOR_RATE_CENTS, 5300);
  assert.deepEqual(LABOR_MAN_HOURS, { min: 0.5, max: 200, step: 0.25 });
  assert.deepEqual(laborRate({ approvals: { items: {}, revision: null } }), { rateCents: 5300, source: 'default', reason: 'Owner decision (2026-10-19): $53.00 per man-hour.' });
  assert.deepEqual(laborRate({ approvals: { items: {}, revision: 'r', laborRatePerManHourCents: 4500 } }).rateCents, 4500);
  for (const [value, ok] of [[0.5, true], [0.75, true], [6, true], [6.25, true], [199.75, true], [200, true], [0.25, false], [0, false], [-1, false], [6.1, false], [200.25, false], ['6', false], [null, false], [NaN, false], [Infinity, false]]) assert.equal(validManHours(value), ok, String(value));
  // The estimate's person-minutes as man-hours: to the nearest quarter hour, kept within the bounds.
  assert.equal(manHoursOf(360), 6);
  assert.equal(manHoursOf(810), 13.5);
  assert.equal(manHoursOf(735), 12.25, '12.25 exactly (735 person-minutes)');
  assert.equal(manHoursOf(544), 9, '544 person-minutes is 9.07 hours: 9 to the nearest quarter');
  assert.equal(manHoursOf(20), 0.5, 'never below half an hour');
  assert.equal(manHoursOf(28800), 200, 'never above 200');
  // Total = man-hours × rate to the cent.
  assert.equal(laborTotalCents(6, DEFAULT_LABOR_RATE_CENTS), 31800, '6 × $53.00 = $318.00');
  assert.equal(laborTotalCents(6.25, DEFAULT_LABOR_RATE_CENTS), 33125, '6.25 × $53.00 = $331.25');
  assert.equal(laborTotalCents(6, 4000), 24000, 'the earlier $40.00 rate, as a saved owner rate: 6 × $40.00 = $240.00');
  assert.equal(laborTotalCents(0.25 * 3, 4050), 3038, '0.75 × $40.50 = $30.375, half up');
  assert.equal(laborTotalCents(0.5, 4001), 2001, '0.5 × $40.01 = $20.005, half up');
  assert.equal(laborTotalCents(200, 100000), 20000000);
});

test('every builder quote with garage work carries the Labor line; such a quote without labor is never saved, sent or signed', async () => {
  const state = builderState();
  const priced = priceCompositeQuote(state, selection(), { complete: true });
  assert.deepEqual(priced.lineItems.filter(line => line.kind === 'labor').map(line => [line.id, line.name, line.totalCents]), [[LABOR_ID, 'Labor', LABOR_CENTS]]);
  assert.equal(priced.totalCents, priced.breakdown.sections.reduce((sum, section) => sum + section.subtotalCents, 0) + LABOR_CENTS);
  assert.deepEqual(priced.storedLineItems.at(-1).split, null, 'labor is attributed by its kind; it carries no cost split or minutes');
  // A save (complete) without labor, or without man-hours and an estimate to pre-fill them, is refused.
  assert.throws(() => priceCompositeQuote(state, selection({ labor: null }), { complete: true }), { code: 'quote_draft_composite_labor_required', status: 400 });
  // Without the walkthrough time model there is no estimate to pre-fill from: the estimator must enter the man-hours.
  const untimed = { ...state, walkthrough: { ...state.walkthrough, minutes: undefined } };
  assert.throws(() => priceCompositeQuote(untimed, selection({ labor: { manHours: null } }), { complete: true }), { code: 'quote_draft_composite_labor_required' });
  // A step preview may leave the labor out; a full preview without man-hours says what is missing.
  const step = priceCompositeQuote(state, { ...selection({ labor: null }), steps: ['removal'], shelving: [], storage: [] });
  assert.deepEqual([step.labor, step.lineItems.some(line => line.kind === 'labor')], [null, false]);
  const missing = priceCompositeQuote(untimed, selection({ labor: { manHours: null } }));
  assert.deepEqual([missing.labor.manHours, missing.labor.totalCents, missing.lineItems.some(line => line.kind === 'labor')], [null, null, false]);
  assert.match(missing.approval.blocked.find(row => row.id === LABOR_ID).reason, /Enter the estimated man-hours for the Labor line/);
  assert.equal(missing.approval.blocked.some(row => row.id === 'goods-installation'), false, 'goods wait for the man-hours, never for the installation question');
  // A signed handoff of a saved selection without labor (a draft saved before the Labor line) is refused as well.
  const f = fixture(), old = selection({ labor: null });
  const draft = priceCompositeQuote(state, { ...old, labor: LABOR }, { complete: true });
  const saved = await saveQuoteDraft(f.store, estimator, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { client: client(1), title: 'Garage reset', scope: 'Reset.', line_items: draft.lineItems, valid_until: '2026-10-30', catalog_version: draft.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: draft.compositePricing } }, NOW, { env: ON_ENV, compositeState: async () => state });
  const legacy = structuredClone(f.job(saved.job.id)); legacy.quoteDraft.compositePricing = old; f.rows.set(`jobs/${saved.job.id}`, legacy);
  await assert.rejects(saveWalkthroughHandoff(f.store, estimator, { ...handoff(1, { total: draft.totalCents / 100 }), actorId: estimator.user, sourceRevision: f.rows.get('jobs/w1').revision, jobId: legacy.id, expectedRevision: legacy.revision }, NOW, { env: ON_ENV, compositeState: async () => state }),
    { code: 'quote_draft_composite_labor_required' });
});

test('the signed handoff prices the labor again from the man-hours and the server rate: a tampered amount, rate or total is refused', async () => {
  const state = builderState(), priced = priceCompositeQuote(state, selection(), { complete: true }), lines = signedLines(priced);
  const sign = (n, quote) => saveWalkthroughHandoff(fixture().store, owner, handoff(n, quote), NOW, { env: ON_ENV, compositeState: async () => state });
  const mismatch = error => error.code === 'handoff_builder_price_mismatch' && error.status === 409 && error.details.totalCents === priced.totalCents;
  // A cheaper Labor line with the matching lower total: the server's own labor price differs.
  const cheap = lines.map(line => line.id === LABOR_ID ? { ...line, name: 'Labor: 6 man-hours × $20.00', unitCents: 12000, totalCents: 12000 } : line);
  await assert.rejects(sign(1, { composite_pricing: priced.compositePricing, line_items: cheap, catalog_version: priced.menuVersion, total: (priced.totalCents - 12000) / 100 }), mismatch);
  // The Labor line dropped (and the total with it).
  await assert.rejects(sign(1, { composite_pricing: priced.compositePricing, line_items: lines.filter(line => line.id !== LABOR_ID), catalog_version: priced.menuVersion, total: (priced.totalCents - LABOR_CENTS) / 100 }), mismatch);
  // The right lines but a total without the labor.
  await assert.rejects(sign(1, { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion, total: (priced.totalCents - LABOR_CENTS) / 100 }), mismatch);
  // A rate smuggled into the selection is refused before anything is priced.
  await assert.rejects(sign(1, { composite_pricing: { ...priced.compositePricing, labor: { ...priced.compositePricing.labor, rateCents: 1000 } }, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), { code: 'quote_draft_composite_invalid_labor' });
  // More man-hours with the browser's own (lower) total: the server prices 8 man-hours at $53.00 and refuses the total.
  await assert.rejects(sign(1, { composite_pricing: { ...priced.compositePricing, labor: { ...priced.compositePricing.labor, manHours: 8 } }, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }),
    error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === priced.totalCents + 2 * DEFAULT_LABOR_RATE_CENTS);
  // The honest signature books the job with the server's labor, its total and deposit.
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id);
  assert.deepEqual([job.total, job.estimate.depositRequired, job.estimate.lineItems.at(-1).id, job.compositeQuote.breakdown.labor.manHours], [priced.totalCents / 100, Math.round(priced.totalCents / 4) / 100, LABOR_ID, 6]); // the 25% deposit (D-DEPOSIT)
  // The owner's own rate ($50.00, below the $53.00 default) prices it the next time: a signature at the old amount is then
  // refused, the server's total being 6 × ($50.00 - $53.00) = $18.00 lower.
  const ownerRate = { ...state, approvals: { ...state.approvals, laborRatePerManHourCents: 5000 } };
  await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => ownerRate }),
    error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === priced.totalCents - 1800);
});

test('the dispatch duration of a sold builder job still comes from the time estimate: the Labor line carries no minutes', async () => {
  const state = builderState(), priced = priceCompositeQuote(state, selection({ labor: { manHours: 12, adjusted: true, fullness: 'medium' } }), { complete: true });
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id), duration = suggestedDuration(job);
  assert.deepEqual([duration.source, duration.minutes, job.estimatedDurationMin], ['estimated_duration', 180, 180], 'adjusting the man-hours changes the price, not the booked time');
  assert.deepEqual([priced.labor.adjusted, priced.labor.prefilledManHours], [true, ESTIMATE_MAN_HOURS]);
});

test('commission classification: the Labor line is no evidence of garage work, so a junk-only builder sale still waits for the office', () => {
  const state = builderState();
  const junk = priceCompositeQuote(state, selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 1 }], shelving: [], storage: [] }), { complete: true });
  const garage = priceCompositeQuote(state, selection(), { complete: true });
  const job = priced => ({ compositeQuote: { version: 1 }, estimate: { lineItems: priced.storedLineItems } });
  assert.equal(signedGarageWork(job(junk)), false, 'a truck load is junk removal');
  // A junk-only quote signed on 2026-10-18 before D-JUNK carried a Labor line named with its man-hours: still no evidence.
  const earlier = [...junk.storedLineItems, { id: LABOR_ID, kind: 'labor', name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour.', quantity: 1, unitCents: 24000, totalCents: 24000, optional: false, selected: true, taxable: false }];
  assert.equal(signedGarageWork({ estimate: { lineItems: earlier } }), false, 'a truck load and its earlier Labor line is junk removal');
  assert.equal(signedGarageWork(job(garage)), true, 'a garage base and goods are garage work');
  // The same rule as before for every other line, a labor-kind line of another quote included.
  assert.equal(signedGarageWork({ estimate: { lineItems: [{ id: 'install', kind: 'labor', name: 'Shelf installation', quantity: 1, unitCents: 9000, totalCents: 9000 }] } }), true);
});

test('flag off: a page that sends a labor selection gets exactly the answers and the job it got before the Labor line', async () => {
  // The quote API: the builder menu, the step preview and a save carrying composite_pricing answer as before.
  const f = fixture(BASE_ENV), quotes = quoteDraftHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW), compositeState: async () => { throw new Error('never read with the flag off'); } });
  const request = (method, body, query = '') => new Request(`https://easygaragecleaning.com/api/quote-draft${query}`, method === 'POST' ? { method, headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
  const answer = async response => ({ status: response.status, body: await response.json() });
  for (const compositePricing of [selection({ labor: null }), selection()]) {
    assert.deepEqual(await answer(await quotes.post({ request: request('POST', { action: 'composite_preview', compositePricing }), env: BASE_ENV })), { status: 400, body: { ok: false, code: 'quote_draft_invalid_request', error: 'Choose save, sync_capture, catalog_preview, send_preview or send.' } });
  }
  assert.deepEqual((await answer(await quotes.get({ request: request('GET', null, '?view=builder'), env: BASE_ENV }))).body.code, 'quote_draft_invalid_request');
  // The signed handoff ignores the selection: with or without labor in it, the same job is booked.
  const book = async compositePricing => {
    const g = fixture(BASE_ENV), input = { ...handoff(1, { composite_pricing: compositePricing }), requestId: '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0101' };
    const result = await saveWalkthroughHandoff(g.store, owner, input, NOW, { env: BASE_ENV, compositeState: async () => { throw new Error('never read with the flag off'); } });
    const { handoffFingerprint, ...job } = g.job(result.job.id), { fingerprint, ...receipt } = g.rows.get(`walkthroughHandoffs/${input.requestId}`);
    return { result, job, receipt };
  };
  const without = await book(selection({ labor: null })), withLabor = await book(selection());
  assert.deepEqual(withLabor, without, 'only the request fingerprint differs');
  assert.ok(!JSON.stringify(withLabor.job.estimate).includes('"labor"'), 'no Labor line with the flag off');
  assert.deepEqual([withLabor.job.compositeQuote, withLabor.job.jobInstructions.laborManHours], [undefined, undefined]);
});

// ---- D-JUNK (owner, 2026-10-18): "the truck price covers the crew's time" ($1,000 per truck since 2026-10-21). ----
const pick = (name, quantity = 1) => ({ id: menuItem(name).id, quantity });
// Every menu price approved at its current amount, so nothing holds a signed job or its customer documents.
const allApproved = () => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState(prices); };
const signedQuote = priced => ({ composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 });

test('D-JUNK: a junk-only quote is $1,000 per truck with no Labor line: complete, sendable and signable without one', async () => {
  const state = builderState();
  assert.deepEqual(HAULING_GROUPS, ['junk', 'special', 'access']);
  // However many trucks, and whatever labor an older page still sends (none, the pre-fill, man-hours set by hand), the
  // quote is the trucks alone: no Labor line, no labor in the saved selection or breakdown, and ready to send.
  for (const trucks of [1, 2, 3]) for (const labor of [null, { manHours: null, fullness: 'packed' }, { manHours: 6, adjusted: true, fullness: 'medium' }]) {
    const priced = priceCompositeQuote(state, selection({ removal: [pick('Full truck load', trucks)], shelving: [], storage: [], labor }), { complete: true });
    assert.deepEqual([priced.totalCents, priced.junkOnly, priced.labor, priced.lineItems.map(line => line.id), 'labor' in priced.compositePricing, 'labor' in priced.breakdown, priced.steps.map(step => step.id), priced.approval],
      [100000 * trucks, true, null, ['removal-junk-full'], false, false, ['removal', 'shelving', 'storage'], { ready: true, blocked: [] }], `${trucks} truck(s), labor ${JSON.stringify(labor)}`);
  }
  // Partial loads, special-handling items and access charges go with junk removal: still no Labor line.
  const mixed = priceCompositeQuote(state, selection({ removal: [pick('Full truck load'), pick('Half load'), pick('Mattress', 2), pick('Stairs')], shelving: [], storage: [] }), { complete: true });
  assert.deepEqual([mixed.junkOnly, mixed.labor, mixed.totalCents, junkOnly(mixed.breakdown.lines)], [true, null, 100000 + 50000 + 14000 + 19000, true]);
  assert.deepEqual(mixed.approval.blocked.map(row => row.id), [menuItem('Mattress').id, menuItem('Stairs').id], 'only the draft prices wait for the owner (the truck loads are approved), never labor');
  // Signed on the walkthrough: booked at $1,000 with no Labor line, labor section or man-hours anywhere on the job.
  const truck = priceCompositeQuote(state, selection({ removal: [pick('Full truck load')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(truck)), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id);
  assert.deepEqual([job.total, job.estimate.lineItems.map(line => line.id), job.compositeQuote.compositePricing.labor, job.compositeQuote.breakdown.labor, job.pricesPendingApproval ?? null, job.jobInstructions.laborManHours],
    [1000, ['removal-junk-full'], undefined, undefined, null, undefined]);
  assert.equal(job.jobBreakdown.sections.some(section => section.id === 'labor'), false);
  assert.equal('labor_man_hours' in job.acceptedHandoffPayload.quote, false);
  assert.equal(walkthroughCrewBrief(job.jobInstructions).some(row => row.label === 'Man-hours sold'), false);
  // A page that sends the labor pre-fill with the junk selection is priced the same: the labor is dropped.
  const g = fixture(), withLabor = { ...signedQuote(truck), composite_pricing: { ...truck.compositePricing, labor: { manHours: null, fullness: 'medium' } } };
  const again = await saveWalkthroughHandoff(g.store, owner, handoff(1, withLabor), NOW, { env: ON_ENV, compositeState: async () => state });
  assert.deepEqual([g.job(again.job.id).total, g.job(again.job.id).compositeQuote.compositePricing.labor], [1000, undefined]);
  // The morning's $1,000 + labor ($990) for a truck is refused at signature: the server's price is $1,000.
  const morning = [...signedLines(truck), { id: LABOR_ID, kind: 'labor', name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour.', quantity: 1, unitCents: 24000, totalCents: 24000 }];
  await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, handoff(1, { ...withLabor, line_items: morning, total: 990 }), NOW, { env: ON_ENV, compositeState: async () => state }),
    error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === 100000);
  // A junk-only quote saved before D-JUNK with a Labor line: unsent, it is saved again before it is sent (the save drops
  // the line); signed, it keeps the price the customer signed.
  const earlier = { ...truck.breakdown, labor: { manHours: 6, rateCents: 4000, rateSource: 'default', totalCents: 24000, prefilledManHours: 6, adjusted: false, belowEstimate: false, estimate: null } };
  const unsent = compositeApproval(earlier, state);
  assert.deepEqual(unsent.blocked.map(row => row.id), [LABOR_ID]);
  assert.match(unsent.blocked[0].reason, /junk-only quote still has a Labor line .* the truck-load price covers the crew's time, so a junk-only quote has no Labor line\. Edit the quote and save it again/);
  assert.deepEqual(compositeApproval(earlier, state, { signed: true }), { ready: true, blocked: [] });
});

test('D-JUNK: the labor estimate counts set-up, sorting, cleaning and installation, never truck loads, special items or access', () => {
  const state = builderState(), est = (removal, { shelving = [], fullness = 'medium' } = {}) => laborEstimate({ removal, shelving, storage: [], labor: { fullness } }, state);
  const base = pick('Two-car garage base'), garage = est([base]);
  // Set-up and sweep-out (60) and sorting a medium-full garage (30), for the model's crew of 2.
  assert.deepEqual([garage.personMinutes, garage.removalPersonMinutes, garage.manHours], [2 * (60 + 30), 180, 3]);
  assert.deepEqual(est([base, pick('Full truck load', 4), pick('Half load'), pick('Mattress', 3), pick('Hot tub dismantle and haul'), pick('Stairs'), pick('Long carry')]), garage,
    'four trucks, a half load, special items and both access charges add no labor time: their own prices pay for it');
  // What it keeps: the garage's sorting by its fullness, the cleaning add-ons and the install time.
  assert.equal(est([base], { fullness: 'packed' }).personMinutes, 2 * (60 + 120));
  assert.equal(est([base, pick('Deep cleaning, two-car')]).personMinutes, 2 * (60 + 30 + 90));
  assert.equal(est([pick('One-car garage base'), pick('Pressure washing, one-car')]).personMinutes, 2 * (60 + 30 + 60));
  assert.equal(est([base], { shelving: [{ id: SHELF.id, quantity: 2 }] }).installPersonMinutes, 2 * 60);
  // With no cleaning base there is no garage to sort: the fullness adds nothing to a load with a cleaning add-on.
  assert.equal(est([pick('Full truck load'), pick('Deep cleaning, two-car')], { fullness: 'packed' }).personMinutes, 2 * (60 + 90));
  // Every quote with garage work still needs its Labor line, priced on that estimate: a cleaning base, a cleaning add-on,
  // shelving or storage next to the trucks.
  for (const work of [{ removal: [base, pick('Full truck load')] }, { removal: [pick('Full truck load'), pick('Mouse trapping')] }, { removal: [pick('Full truck load')], shelving: [{ id: SHELF.id, quantity: 1 }] },
    { removal: [pick('Full truck load')], storage: [{ id: menuItem('HDX 27-gal totes, four-pack').id, quantity: 1 }] }]) {
    const sel = selection({ shelving: [], storage: [], ...work, labor: null });
    assert.throws(() => priceCompositeQuote(state, sel, { complete: true }), { code: 'quote_draft_composite_labor_required', status: 400 }, JSON.stringify(work));
    assert.equal(priceCompositeQuote(state, { ...sel, labor: { manHours: null, fullness: 'medium' } }, { complete: true }).junkOnly, false);
  }
  const priced = priceCompositeQuote(state, selection({ removal: [base, pick('Full truck load', 3)], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  assert.deepEqual([priced.labor.manHours, priced.labor.totalCents, priced.totalCents], [3, 15900, 97500 + 3 * 100000 + 15900], 'three trucks: $1,000 each, and 3 man-hours of garage work at $53.00');
});

test('D-LABOR-TEXT: the customer sees the Labor line as one amount; the staff keep the man-hours; a job signed with the earlier Labor line still renders', async t => {
  const state = allApproved(), priced = priceCompositeQuote(state, selection(), { complete: true });
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced)), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id), hourly = /man-hour|per hour|hourly|billed per|\$40\.00|\$53\.00/i;
  assert.equal(job.pricesPendingApproval ?? null, null, 'every price approved: the customer documents are not withheld');
  assert.deepEqual(['name', 'description', 'totalCents'].map(key => job.estimate.lineItems.at(-1)[key]), ['Labor', 'Includes installing the shelving and storage.', LABOR_CENTS]);
  // What the customer reads: the estimate and invoice documents, the invoice lines and the portal's estimate card.
  const customerViews = async (row, n) => {
    const estimate = renderMoneyDocument(row, { kind: 'estimate', now: NOW }), invoice = renderMoneyDocument(row, { kind: 'invoice', now: NOW });
    portalStore(t, { [`job-${n}`]: { ...row, id: `job-${n}` } });
    const portal = await portalView(portalHandlers(), await portalCookie(`job-${n}`));
    assert.equal(portal.status, 200);
    return { estimate, invoice, lines: invoiceLineItems(row).lineItems, portal: portal.body.estimate.lineItems };
  };
  for (const [label, row, n] of [['signed today', job, 1], ['signed with the earlier Labor line', (() => { const earlier = structuredClone(job);
    Object.assign(earlier.estimate.lineItems.at(-1), { name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour, including installing the shelving and storage.' }); return earlier; })(), 2]]) {
    const views = await customerViews(row, n);
    for (const html of [views.estimate, views.invoice]) {
      assert.match(html, /<td><strong>Labor<\/strong><small>Includes installing the shelving and storage\.<\/small><\/td><td class="amount">\$318\.00<\/td>/, label);
      assert.doesNotMatch(html, hourly, `${label}: no man-hours, rate or hourly wording`);
    }
    assert.deepEqual(views.portal.at(-1), { name: 'Labor', description: 'Includes installing the shelving and storage.', quantity: 1, amount: 318 }, label);
    assert.doesNotMatch(JSON.stringify(views.portal), hourly, label);
    // The records keep the line as it was signed (the invoice record's lines, the staff's money views and the estimate
    // fingerprint): the customer's one amount is how it is shown, so nothing about a signed estimate changes.
    assert.deepEqual(views.lines.filter(line => line.kind === 'labor').map(line => [line.name, line.totalCents]), [[row.estimate.lineItems.at(-1).name, LABOR_CENTS]], label);
  }
  // The earlier line is still the builder's own; a labor line a person wrote on another quote is shown as written.
  assert.equal(builderLaborLine({ id: LABOR_ID, kind: 'labor', name: 'Labor: 6.25 man-hours × $45.00' }), true);
  const handWritten = { id: 'install', kind: 'labor', name: 'Shelf installation, 2 hours', description: 'Two installers.', quantity: 1, unitCents: 9000, totalCents: 9000 };
  assert.deepEqual(customerLaborLine(handWritten), handWritten);
  const removalOnly = customerLaborLine({ id: LABOR_ID, kind: 'labor', name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour.' });
  assert.deepEqual([removalOnly.name, removalOnly.description], ['Labor', '']);
  // Shown, never stored: the office's money view of a job signed with the earlier line lists the line as it was signed,
  // so saving that estimate back unchanged is no revision of what the customer signed.
  const signedEarlier = structuredClone(job); Object.assign(signedEarlier.estimate.lineItems.at(-1), { name: 'Labor: 6 man-hours × $40.00' });
  const office = moneyProjection(signedEarlier, NOW).lineItems;
  assert.equal(office.at(-1).name, 'Labor: 6 man-hours × $40.00');
  assert.equal(estimateChanged(signedEarlier.estimate, { ...signedEarlier.estimate, lineItems: signedEarlier.estimate.lineItems.map((line, index) => ({ ...line, name: office[index].name })) }), false);
  // The staff keep the man-hours: the crew brief, the job breakdown and the HighLevel internal note.
  assert.deepEqual(job.jobBreakdown.sections.at(-1), { id: 'labor', title: 'Labor', items: ['6 man-hours sold'] });
  assert.deepEqual(walkthroughCrewBrief(job.jobInstructions).find(row => row.label === 'Man-hours sold'), { label: 'Man-hours sold', text: '6 man-hours' });
  assert.match(scheduleMirrorNote({ kind: 'scheduled', job }).body, /\nLabor: 6 man-hours sold\n/);
  assert.deepEqual([job.acceptedHandoffPayload.quote.line_items.at(-1).name, job.acceptedHandoffPayload.quote.labor_man_hours], ['Labor', 6], 'the HighLevel internal brief names them (api/highlevel.js)');
  assert.deepEqual([job.compositeQuote.breakdown.labor.manHours, job.compositeQuote.breakdown.labor.rateCents, job.compositeQuote.breakdown.labor.version], [6, DEFAULT_LABOR_RATE_CENTS, 2]);
  // A signed job whose breakdown predates the version keeps what was signed at send-time checks (the office's release).
  const { version, ...morningLabor } = job.compositeQuote.breakdown.labor;
  assert.deepEqual(compositeApproval({ ...job.compositeQuote.breakdown, labor: morningLabor }, state, { signed: true }), { ready: true, blocked: [] });
});

// The three decisions together, signed in person on the walkthrough (D-DEPOSIT terms 2026-10-deposit25): a junk-only quote
// is $1,000 per truck with no Labor line and its 25% deposit (D-JUNK), and a garage quote's Labor line reaches the homeowner
// as one amount (D-LABOR-TEXT) inside the same 25% now / 75% on the job day split.
test('D-JUNK, D-LABOR-TEXT and D-DEPOSIT together: a junk-only quote signs at $1,000 per truck with 25% down; a garage quote signs "Labor" as one amount with 25% now and 75% on the job day', async t => {
  const state = allApproved(), hourly = /man-hour|per hour|hourly|billed per|\$40\.00|\$53\.00/i;
  const terms = row => [row.estimate.commercialPolicy?.version, row.estimate.paymentSchedule?.depositCents, row.estimate.paymentSchedule?.remainderCents, row.estimate.paymentSchedule?.depositDueDate, row.estimate.paymentSchedule?.remainderDueDate];
  const rows = (row, id) => moneyDocumentModel({ ...row, id }, { kind: 'estimate', now: NOW }).rows.filter(entry => !/^(Payments received|Total unpaid|Balance due)$/.test(entry.label)).map(entry => [entry.label, entry.cents]);
  const portal = async (row, id) => { portalStore(t, { [id]: { ...row, id } }); const view = await portalView(portalHandlers(), await portalCookie(id)); assert.equal(view.status, 200); return view.body; };
  // Junk only, two trucks: $2,000, no Labor line, $500 now and $1,500 on Monday's job.
  const trucks = priceCompositeQuote(state, selection({ removal: [pick('Full truck load', 2)], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const f = fixture(), junk = f.job((await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(trucks)), NOW, { env: ON_ENV, compositeState: async () => state })).job.id);
  assert.deepEqual([junk.total, junk.deposit.amount, junk.estimate.depositRequired, junk.estimate.lineItems.map(line => line.id), junk.acceptedHandoffPayload.terms_version], [2000, 500, 500, ['removal-junk-full'], '2026-10-deposit25']);
  assert.deepEqual(terms(junk), ['2026-10-deposit25', 50000, 150000, '2026-10-17', MON]);
  assert.deepEqual(rows(junk, 'job-junk'), [['Total', 200000], ['25% deposit due 2026-10-17', 50000], [`Scheduled 75% remainder due ${MON}`, 150000]]);
  const junkPortal = await portal(junk, 'job-junk');
  assert.deepEqual([junkPortal.estimate.depositRequired, junkPortal.payment.dueNow, junkPortal.estimate.lineItems.map(line => line.name)], [500, 500, [junk.estimate.lineItems[0].name]]);
  assert.doesNotMatch(JSON.stringify(junkPortal.estimate), /Labor|man-hour/i, 'no Labor line anywhere the homeowner looks');
  // The old page's 50% of a $1,000 truck is not the deposit the current terms take.
  const half = handoff(2, signedQuote(priceCompositeQuote(state, selection({ removal: [pick('Full truck load')], shelving: [], storage: [] }), { complete: true })));
  half.plan.quote.deposit = 500;
  await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, half, NOW, { env: ON_ENV, compositeState: async () => state }), error => error.code === 'handoff_invalid_amount' && error.status === 400 && /its 25% deposit/.test(error.message));
  // Garage work: the Labor line is "Labor" and its amount, and the whole total, labor included, splits 25% / 75%.
  const priced = priceCompositeQuote(state, selection(), { complete: true }), deposit = Math.round(priced.totalCents / 4);
  const g = fixture(), garage = g.job((await saveWalkthroughHandoff(g.store, owner, handoff(3, signedQuote(priced)), NOW, { env: ON_ENV, compositeState: async () => state })).job.id);
  assert.deepEqual([garage.total, garage.estimate.depositRequired, garage.estimate.lineItems.at(-1).name, garage.estimate.lineItems.at(-1).totalCents], [priced.totalCents / 100, deposit / 100, 'Labor', LABOR_CENTS]);
  assert.deepEqual(terms(garage), ['2026-10-deposit25', deposit, priced.totalCents - deposit, '2026-10-17', MON]);
  assert.deepEqual(rows(garage, 'job-garage'), [['Total', priced.totalCents], ['25% deposit due 2026-10-17', deposit], [`Scheduled 75% remainder due ${MON}`, priced.totalCents - deposit]]);
  const html = renderMoneyDocument({ ...garage, id: 'job-garage' }, { kind: 'estimate', now: NOW });
  assert.match(html, /<td><strong>Labor<\/strong><small>Includes installing the shelving and storage\.<\/small><\/td><td class="amount">\$318\.00<\/td>/);
  assert.doesNotMatch(html, hourly);
  const garagePortal = await portal(garage, 'job-garage');
  assert.deepEqual([garagePortal.estimate.lineItems.at(-1), garagePortal.estimate.depositRequired, garagePortal.payment.dueNow], [{ name: 'Labor', description: 'Includes installing the shelving and storage.', quantity: 1, amount: 318 }, deposit / 100, deposit / 100]);
  assert.match(garagePortal.estimate.terms, /25% deposit .* due 2026-10-17; 75% remainder .* due 2026-10-19/);
  assert.doesNotMatch(JSON.stringify(garagePortal.estimate), hourly);
  // The staff still see the man-hours sold.
  assert.deepEqual(walkthroughCrewBrief(garage.jobInstructions).find(row => row.label === 'Man-hours sold'), { label: 'Man-hours sold', text: '6 man-hours' });
});

// Owner decision 2026-10-21: the full truck went from $750 to $1,000 (partial loads draft from it). A job keeps the terms
// it was signed on: one signed at $750 keeps $750 and its $187.50 deposit wherever the homeowner looks, while an unsent
// draft still at $750 is refused at send until it is saved again at the new price, so no new quote goes out at $750.
test('the $1,000 truck: a job signed at $750 keeps its price and deposit; an unsent $750 draft must be saved again before it is sent', async t => {
  const now = allApproved(), menuAt750 = structuredClone(now.menu);
  menuAt750.services.find(item => item.basis.kind === 'junk' && item.basis.fraction === 1).approvedPriceCents = 75000;
  const before = { ...now, menu: menuAt750 };
  const truck = (state, quantity = 1) => priceCompositeQuote(state, selection({ removal: [pick('Full truck load', quantity)], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  assert.deepEqual([truck(before).totalCents, truck(now).totalCents, truck(now, 2).totalCents], [75000, 100000, 200000]);
  const half = priceCompositeQuote(now, selection({ removal: [pick('Half load')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  assert.equal(half.totalCents, 50000, 'a partial load scales from the $1,000 truck');
  // Signed yesterday at $750: today's $1,000 menu changes nothing on the job or the homeowner's portal.
  const f = fixture(), signed = f.job((await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(truck(before))), NOW, { env: ON_ENV, compositeState: async () => before })).job.id);
  assert.deepEqual([signed.total, signed.estimate.amountCents, signed.estimate.depositRequiredCents], [750, 75000, 18750]);
  portalStore(t, { 'job-750': { ...signed, id: 'job-750' } });
  const view = (await portalView(portalHandlers(), await portalCookie('job-750'))).body;
  assert.deepEqual([view.estimate.amount, view.estimate.depositRequired], [750, 187.5], 'the signed price and deposit, not today\'s menu');
  // The same $750 quote saved but never sent is held at send: the owner's price is now $1,000.
  const unsent = compositeApproval(truck(before).breakdown, now);
  assert.deepEqual(unsent.blocked.map(row => [row.id, row.unitCents]), [[menuItem('Full truck load').id, 75000]]);
  assert.match(unsent.blocked[0].reason, /^The owner approved \$1,000\.00 for .*, but this quote has \$750\.00\. Save the quote again to use the approved price\.$/);
  assert.equal(unsent.blocked[0].resave, true, 'flagged as a re-save: no owner approval is needed');
});

// A job held at signing for one draft price is released by the owner's approval of that item, at the amounts it was
// signed at (the customer keeps the price signed): a truck load signed at $750 stays at $750 under the $1,000 menu, a
// partial load that was a draft at signing is accepted at its signed amount, and a mattress signed at $70 stays $70 when
// the owner approves it at $80.
test('the $1,000 truck: jobs signed under the $750 menu and held for a draft price release at their signed amounts', async () => {
  const menuAt750 = structuredClone(builderState().menu);
  menuAt750.menuVersion = '2026-10-16.1';
  for (const item of menuAt750.services.filter(row => row.basis?.kind === 'junk')) {
    if (item.basis.fraction === 1) { item.approvedPriceCents = 75000; continue; }
    item.status = 'draft'; delete item.approvedPriceCents; delete item.approval;
  }
  const before = { ...builderState(), menu: menuAt750 };
  const quote = removal => priceCompositeQuote(before, { ...selection({ removal, shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), menuVersion: menuAt750.menuVersion }, { complete: true });
  const mattress = quote([pick('Full truck load'), pick('Mattress')]), half = quote([pick('Full truck load'), pick('Half load')]);
  assert.deepEqual([mattress.totalCents, half.totalCents], [82000, 112500]);
  assert.deepEqual([mattress.approval.blocked.map(row => row.id), half.approval.blocked.map(row => row.id)], [[menuItem('Mattress').id], [menuItem('Half load').id]]);
  const f = fixture();
  const sign = async (n, priced) => f.job((await saveWalkthroughHandoff(f.store, owner, handoff(n, signedQuote(priced)), NOW, { env: ON_ENV, compositeState: async () => before })).job.id);
  const release = (job, state) => releaseHandoffPrices(f.store, owner, { action: 'prices.release', requestId: randomUUID(), jobId: job.id, expectedRevision: f.job(job.id).revision }, LATER, { env: ON_ENV, compositeState: async () => state });
  const withMattress = await sign(1, mattress), withHalf = await sign(2, half);
  assert.deepEqual([withMattress.compositeQuote.approval.pending, withHalf.compositeQuote.approval.pending].map(rows => rows.map(row => row.id)), [[menuItem('Mattress').id], [menuItem('Half load').id]]);
  // Today's menu: the truck is $1,000 and the half load approved at $500; the mattress still waits for the owner.
  await assert.rejects(release(withMattress, builderState()), error => error.code === 'quote_draft_composite_prices_unapproved' && error.details.unapproved.map(row => row.id).join() === menuItem('Mattress').id, 'only the mattress holds it, not the $750 truck');
  // The owner approves the mattress at $80, not the $70 it was signed at: the customer keeps the $70 signed, and both jobs
  // release at their signed totals. A signed job is never told to save the quote again.
  const approved = builderState({ [menuItem('Mattress').id]: 8000 });
  assert.deepEqual(compositeApproval(withMattress.compositeQuote.breakdown, approved, { signed: true }), { ready: true, blocked: [] });
  assert.deepEqual(compositeApproval(withMattress.compositeQuote.breakdown, approved).blocked.map(row => [row.id, row.resave]), [[menuItem('Full truck load').id, true], [menuItem('Mattress').id, true]], 'the same lines unsent are saved again');
  for (const [job, total] of [[withMattress, 820], [withHalf, 1125]]) { // $750 + $70; $750 + $375
    const result = await release(job, approved);
    assert.deepEqual([result.released, f.job(job.id).total, f.job(job.id).estimate.amountCents, f.job(job.id).pricesPendingApproval, f.job(job.id).pricesRelease.gate], [true, total, total * 100, null, 'approved_prices'], `job ${job.id}`);
  }
});

test('a draft price is never flagged as a re-save: it needs the owner', () => {
  const priced = priceCompositeQuote(builderState(), selection({ removal: [pick('Full truck load'), pick('Mattress')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  assert.deepEqual(priced.approval.blocked.map(row => [row.id, row.resave ?? null]), [[menuItem('Mattress').id, null]]);
});

// The refusal's headline names only what waits for the owner; a price the owner changed since (the estimator saves the
// quote again) is said apart.
test('a refused send with a changed truck price and a draft price names only the draft price as unapproved', () => {
  const now = builderState(), menuAt750 = structuredClone(now.menu);
  menuAt750.services.find(item => item.basis?.kind === 'junk' && item.basis.fraction === 1).approvedPriceCents = 75000;
  const priced = priceCompositeQuote({ ...now, menu: menuAt750 }, selection({ removal: [pick('Full truck load'), pick('Mattress')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const refusal = approvalRefusal(compositeApproval(priced.breakdown, now));
  assert.equal(refusal.message, 'This quote has 1 price the owner has not approved: Mattress. It stays saved as a draft and can be sent once the owner approves it in Hub > Catalog & pricing. The owner changed the price of Full truck load since it was saved: save the quote again to use the approved price; no owner approval is needed for that.');
  assert.deepEqual(refusal.details.unapproved.map(row => [row.name, row.resave ?? false]), [['Full truck load', true], ['Mattress', false]]);
});
