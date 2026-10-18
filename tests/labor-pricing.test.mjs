// D12 (owner, 2026-10-18): "We have to price man hours estimated to do the job. It's $40 an hour." Every builder quote
// carries a Labor line = the estimated man-hours x the owner's labor rate ($40.00 per man-hour until the owner changes it
// on Menu prices), on top of the menu lines; the man-hours are pre-filled from the job's own time estimate (crew size x
// hours on site) and the estimator may adjust them. The rate is never read from the browser, and the signed handoff
// prices the labor again exactly like every other builder line. Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LABOR_RATE_CENTS, LABOR_ID, LABOR_MAN_HOURS, laborRate, laborTotalCents, prefilledManHours, priceCompositeQuote, validManHours } from '../functions/_lib/composite-quote.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { signedGarageWork } from '../functions/_lib/knock-setters.js';
import { suggestedDuration } from '../functions/_lib/dispatch-duration.js';
import { BASE_ENV, LABOR, LABOR_CENTS, NOW, ON_ENV, builderState, client, estimator, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
const handoff = (n, quote, extra = {}) => ({ actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, ...extra, plan: signedPlan(n, { quote, ...(quote.total ? { total: quote.total } : {}) }) });

test('the labor math: $40.00 by default, man-hours 0.5 to 200 in quarter hours, the pre-fill is crew size × hours on site, totals round half up to the cent', () => {
  assert.equal(DEFAULT_LABOR_RATE_CENTS, 4000);
  assert.deepEqual(LABOR_MAN_HOURS, { min: 0.5, max: 200, step: 0.25 });
  assert.deepEqual(laborRate({ approvals: { items: {}, revision: null } }), { rateCents: 4000, source: 'default', reason: 'Owner decision (2026-10-18): $40.00 per man-hour.' });
  assert.deepEqual(laborRate({ approvals: { items: {}, revision: 'r', laborRatePerManHourCents: 4500 } }).rateCents, 4500);
  for (const [value, ok] of [[0.5, true], [0.75, true], [6, true], [6.25, true], [199.75, true], [200, true], [0.25, false], [0, false], [-1, false], [6.1, false], [200.25, false], ['6', false], [null, false], [NaN, false], [Infinity, false]]) assert.equal(validManHours(value), ok, String(value));
  // Pre-fill: crew size × minutes on site / 60, to the nearest quarter hour, kept within the bounds.
  assert.equal(prefilledManHours({ crewSize: 2, onSiteMinutes: 180 }), 6);
  assert.equal(prefilledManHours({ crewSize: 3, onSiteMinutes: 270 }), 13.5);
  assert.equal(prefilledManHours({ crewSize: 3, onSiteMinutes: 245 }), 12.25, '12.25 exactly (735 person-minutes)');
  assert.equal(prefilledManHours({ crewSize: 1, onSiteMinutes: 20 }), 0.5, 'never below half an hour');
  assert.equal(prefilledManHours({ crewSize: 20, onSiteMinutes: 1440 }), 200, 'never above 200');
  assert.equal(prefilledManHours(null), null);
  // Total = man-hours × rate to the cent.
  assert.equal(laborTotalCents(6, 4000), 24000);
  assert.equal(laborTotalCents(6.25, 4000), 25000);
  assert.equal(laborTotalCents(0.25 * 3, 4050), 3038, '0.75 × $40.50 = $30.375, half up');
  assert.equal(laborTotalCents(0.5, 4001), 2001, '0.5 × $40.01 = $20.005, half up');
  assert.equal(laborTotalCents(200, 100000), 20000000);
});

test('every builder quote carries the Labor line; a quote without labor is never saved, sent or signed', async () => {
  const state = builderState();
  const priced = priceCompositeQuote(state, selection(), { complete: true });
  assert.deepEqual(priced.lineItems.filter(line => line.kind === 'labor').map(line => [line.id, line.name, line.totalCents]), [[LABOR_ID, 'Labor: 6 man-hours × $40.00', LABOR_CENTS]]);
  assert.equal(priced.totalCents, priced.breakdown.sections.reduce((sum, section) => sum + section.subtotalCents, 0) + LABOR_CENTS);
  assert.deepEqual(priced.storedLineItems.at(-1).split, null, 'labor is attributed by its kind; it carries no cost split or minutes');
  // A save (complete) without labor, or without man-hours and an estimate to pre-fill them, is refused.
  assert.throws(() => priceCompositeQuote(state, selection({ labor: null }), { complete: true }), { code: 'quote_draft_composite_labor_required', status: 400 });
  assert.throws(() => priceCompositeQuote(state, selection({ labor: { manHours: null, estimate: null } }), { complete: true }), { code: 'quote_draft_composite_labor_required' });
  // A step preview may leave the labor out; a full preview without man-hours says what is missing.
  const step = priceCompositeQuote(state, { ...selection({ labor: null }), steps: ['removal'], shelving: [], storage: [] });
  assert.deepEqual([step.labor, step.lineItems.some(line => line.kind === 'labor')], [null, false]);
  const missing = priceCompositeQuote(state, selection({ labor: { manHours: null, estimate: null } }));
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
  // More man-hours with the browser's own (lower) total: the server prices 8 man-hours at $40.00 and refuses the total.
  await assert.rejects(sign(1, { composite_pricing: { ...priced.compositePricing, labor: { ...priced.compositePricing.labor, manHours: 8 } }, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }),
    error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === priced.totalCents + 8000);
  // The honest signature books the job with the server's labor, its total and deposit.
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id);
  assert.deepEqual([job.total, job.estimate.depositRequired, job.estimate.lineItems.at(-1).id, job.compositeQuote.breakdown.labor.manHours], [priced.totalCents / 100, Math.round(priced.totalCents / 2) / 100, LABOR_ID, 6]);
  // The owner's own rate prices it the next time: a signature at the old amount is then refused.
  const raised = { ...state, approvals: { ...state.approvals, laborRatePerManHourCents: 5000 } };
  await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => raised }),
    error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === priced.totalCents + 6000);
});

test('the dispatch duration of a sold builder job still comes from the time estimate: the Labor line carries no minutes', async () => {
  const state = builderState(), priced = priceCompositeQuote(state, selection({ labor: { manHours: 12, estimate: { crewSize: 2, onSiteMinutes: 180 } } }), { complete: true });
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, { composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id), duration = suggestedDuration(job);
  assert.deepEqual([duration.source, duration.minutes, job.estimatedDurationMin], ['estimated_duration', 180, 180], 'adjusting the man-hours changes the price, not the booked time');
  assert.deepEqual([priced.labor.adjusted, priced.labor.prefilledManHours], [true, 6]);
});

test('commission classification: the Labor line is no evidence of garage work, so a junk-only builder sale still waits for the office', () => {
  const state = builderState();
  const junk = priceCompositeQuote(state, selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 1 }], shelving: [], storage: [] }), { complete: true });
  const garage = priceCompositeQuote(state, selection(), { complete: true });
  const job = priced => ({ compositeQuote: { version: 1 }, estimate: { lineItems: priced.storedLineItems } });
  assert.equal(signedGarageWork(job(junk)), false, 'a truck load and its labor is junk removal');
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
