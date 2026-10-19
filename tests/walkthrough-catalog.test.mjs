// LANE catalog (2026-10-19, owner: "make sure the walkthrough has all of the items we sell and offer and it's integrated
// natively into crew hub and walkthrough"). The walkthrough's cleaning add-ons follow its own garage size, with truck
// loads too: the builder carries the one-car pressure wash over and the server accepts it when the walkthrough garage is
// one-car (composite-quote.js garageSize; the signed handoff prices it with the signed plan's own scope.garages).
// Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { NOW, ON_ENV, builderState, client, estimator, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const pick = (name, quantity = 1) => ({ id: menuItem(name).id, quantity });
const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
const signedQuote = priced => ({ composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 });
const handoff = (n, quote, scope = {}) => {
  const plan = signedPlan(n, { quote, total: quote.total });
  plan.scope = { ...plan.scope, ...scope };
  return { actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, plan };
};

test('the signed handoff prices a one-car pressure wash with a truck load by the signed plan\'s garage size', async () => {
  const state = builderState(), sel = selection({ removal: [pick('Full truck load'), pick('Pressure washing, one-car')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } });
  const priced = priceCompositeQuote(state, { ...sel, garageSize: '1' }, { complete: true });
  assert.deepEqual(priced.lineItems.map(line => line.id), ['removal-junk-full', 'service-egc-006', 'labor']);
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced), { garages: '1', finish: ['cleanout', 'pressure_wash'] }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id);
  assert.equal(job.total, priced.totalCents / 100);
  assert.equal(job.compositeQuote.compositePricing.garageSize, '1', 'the signed selection keeps the garage it was priced for');
  // The page's size never decides: a two-car plan, or one without a known size, refuses the one-car wash with no base.
  for (const garages of ['2', 'garage']) {
    await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, handoff(1, signedQuote(priced), { garages }), NOW, { env: ON_ENV, compositeState: async () => state }),
      error => error.code === 'quote_draft_composite_invalid_selection' && /one-car garage only/.test(error.message), garages);
  }
  // A selection that names no garage is priced exactly as before (no base: no pressure wash).
  const plainSel = priceCompositeQuote(state, selection({ removal: [pick('Full truck load')], shelving: [], storage: [], labor: null }), { complete: true });
  const g = fixture(), plainSigned = await saveWalkthroughHandoff(g.store, owner, handoff(2, signedQuote(plainSel), { garages: '1' }), NOW, { env: ON_ENV, compositeState: async () => state });
  assert.equal(Object.hasOwn(g.job(plainSigned.job.id).compositeQuote.compositePricing, 'garageSize'), false);
});

test('a re-saved builder quote that only adds or changes the walkthrough garage size is not a material revision', async () => {
  const state = builderState(), f = fixture(), options = { env: ON_ENV, compositeState: async () => state };
  const first = priceCompositeQuote(state, selection({ labor: { manHours: 6, fullness: 'medium' } }), { complete: true });
  const input = (pricing, lines, extra = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', ...extra,
    draft: { client: client(1), title: 'Garage reset', scope: 'Reset.', line_items: lines, valid_until: '2026-10-30', catalog_version: first.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: pricing } });
  const saved = await saveQuoteDraft(f.store, estimator, input(first.compositePricing, first.lineItems), NOW, options);
  const row = f.rows.get(`jobs/${saved.job.id}`);
  Object.assign(row.estimate, { status: 'sent', sentRevision: 1, sentAt: NOW });
  row.customerApproval = { status: 'approved', approvedAt: NOW, amount: first.totalCents / 100 };
  // The same selection from an updated page names the walkthrough garage: same lines, same total.
  const again = priceCompositeQuote(state, { ...selection({ labor: { manHours: 6, fullness: 'medium' } }), garageSize: '2' }, { complete: true });
  assert.deepEqual(again.lineItems, first.lineItems);
  await saveQuoteDraft(f.store, estimator, input(again.compositePricing, again.lineItems, { jobId: row.id, expectedRevision: f.job(saved.job.id).revision }), NOW, options);
  const after = f.job(saved.job.id);
  assert.deepEqual([after.estimate.revision, after.estimate.status, after.customerApproval.status], [1, 'sent', 'approved']);
  assert.equal(after.quoteDraft.compositePricing.garageSize, '2', 'the garage size is still saved');
});
