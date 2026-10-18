// Regression (found by tests/e2e-estimator-crew-day.test.mjs): with the owner's flags (EGC_QUOTE_BUILDER_ENABLED on,
// CATALOG_QUOTES_ENABLED off) the quote builder's installation question could not be answered at all. Goods quotes
// wait until the owner confirms that shelving and storage installation is included in the goods price, but that answer
// lived only in the pricing settings, and with catalog pricing off GET /api/catalog shows no settings and
// settings.update is 404 catalog_disabled. Every builder quote with shelving or storage was therefore unsendable, and
// every signed job with goods stayed held from the customer for good. The owner now answers it with the menu approvals
// (POST /api/catalog menu.approve goodsInstallationIncluded), which the builder flag alone opens; either answer counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogHandlers } from '../functions/api/catalog.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { CATALOG_OPERATIONS, MENU_APPROVALS, MAX_MENU_CHANGES, readCompositeState } from '../functions/_lib/catalog-store.js';
import { INSTALLATION_ID, builderMenu, compositeApproval, priceCompositeQuote, validateMenuApprovals } from '../functions/_lib/composite-quote.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { LATER, NOW, ON_ENV, builderState, client, estimator, fixture, menu, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
// An in-memory catalog store: the pricing settings, the menu approvals, receipts and the audit trail.
function catalogStore() {
  const rows = new Map();
  let tick = 0;
  return { rows, read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), commit: async writes => { const at = `rev-${++tick}`; for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(rows.get(`${write.collection}/${write.id}`) || {}), ...structuredClone(write.patch), id: write.id, revision: at }); return { writeResults: writes.map(() => ({ updateTime: at })) }; } };
}
const post = (handlers, body, env = ON_ENV) => handlers.post({ request: new Request(`${ORIGIN}/api/catalog`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
const approve = (state, extra) => ({ action: 'menu.approve', requestId: randomUUID(), expectedRevision: state.approvals.revision, menuVersion: state.menu.menuVersion, settingsVersion: state.settings.settingsVersion, approve: [], revoke: [], ...extra });

test('the owner answers the installation question with the menu approvals while catalog pricing is off; either answer counts and it can be taken back', async () => {
  const store = catalogStore(), handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held: () => ({ heldJobIds: async () => [] }) });
  const state = () => readCompositeState(store);
  // Every goods price approved, the installation not answered: a goods quote is still blocked by it alone.
  const goods = priceCompositeQuote(builderState(), selection(), { complete: true }), approvals = goods.breakdown.lines.filter(line => !line.approved).map(line => ({ id: line.id, unitCents: line.unitCents }));
  const first = await post(handlers, approve(await state(), { approve: approvals }));
  assert.equal(first.status, 200);
  assert.deepEqual(compositeApproval(goods.breakdown, await state()).blocked.map(row => row.id), [INSTALLATION_ID]);
  // The way it was answered before is closed while CATALOG_QUOTES_ENABLED is off.
  const settings = await post(handlers, { action: 'settings.update', requestId: randomUUID(), expectedRevision: null, settings: { ...(await state()).settings, settingsVersion: 'owner-installation', goodsInstallationIncluded: true } });
  assert.deepEqual([settings.status, (await settings.json()).code], [404, 'catalog_disabled']);
  // The answer alone (no price change) is a valid approval request; the receipt and the audit entry record it.
  const answer = approve(await state(), { goodsInstallationIncluded: true }), response = await post(handlers, answer), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual([body.approvals.goodsInstallationIncluded, body.approvals.count, store.rows.get(`${MENU_APPROVALS}/current`).goodsInstallationIncluded], [true, approvals.length, true]);
  assert.deepEqual(store.rows.get(`${CATALOG_OPERATIONS}/${answer.requestId}`).result.installation, { included: true, previous: null });
  const audit = [...store.rows.entries()].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row).find(row => row.requestId === answer.requestId);
  assert.ok(audit, 'audited');
  assert.match(JSON.stringify(audit), /goods-installation/);
  const answered = await state();
  assert.deepEqual([compositeApproval(goods.breakdown, answered), builderMenu(answered).installation, builderMenu(answered, { internal: true }).internal.installationConfirmed, builderMenu(answered, { internal: true }).internal.goodsInstallationIncluded], [{ ready: true, blocked: [] }, { included: true }, true, true]);
  assert.equal(priceCompositeQuote(answered, selection(), { complete: true }).approval.ready, true, 'a new goods quote is ready at once');
  // A later price approval keeps the stored answer; false takes it back and goods wait again.
  const kept = await post(handlers, approve(await state(), { revoke: [approvals[0].id] }));
  assert.equal(kept.status, 200);
  assert.equal(store.rows.get(`${MENU_APPROVALS}/current`).goodsInstallationIncluded, true);
  const back = await post(handlers, approve(await state(), { goodsInstallationIncluded: false }));
  assert.deepEqual([back.status, (await state()).approvals.goodsInstallationIncluded], [200, false]);
  assert.ok(compositeApproval(goods.breakdown, await state()).blocked.some(row => row.id === INSTALLATION_ID));
  assert.deepEqual(builderMenu(await state(), { internal: true }).internal.installationConfirmed, false);
  // A saved pricing-settings answer (catalog pricing on) still counts on its own, as before.
  assert.equal(compositeApproval(goods.breakdown, { ...(await state()), settings: { ...(await state()).settings, goodsInstallationIncluded: true }, approvals: { ...(await state()).approvals, goodsInstallationIncluded: false } }).blocked.some(row => row.id === INSTALLATION_ID), false);
});

test('the installation answer is checked: a boolean, counted as one of the request\'s changes, stored only when given, owner only, and builder-flag only', async () => {
  const store = catalogStore(), handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held: () => ({ heldJobIds: async () => [] }) });
  const state = await readCompositeState(store);
  for (const value of ['yes', 1, null, {}]) {
    const response = await post(handlers, approve(state, { goodsInstallationIncluded: value }));
    assert.deepEqual([response.status, (await response.json()).code], [400, 'catalog_request_invalid'], JSON.stringify(value));
  }
  const drafts = [...menu.products].filter(product => product.id.startsWith('hd-')).slice(0, MAX_MENU_CHANGES);
  assert.equal(drafts.length, MAX_MENU_CHANGES);
  const prices = new Map(builderMenu(builderState()).products.map(product => [product.id, product.unitCents]));
  const full = await post(handlers, approve(state, { approve: drafts.map(product => ({ id: product.id, unitCents: prices.get(product.id) })), goodsInstallationIncluded: true }));
  assert.deepEqual([full.status, (await full.json()).code], [400, 'catalog_request_invalid'], `${MAX_MENU_CHANGES} prices and the answer are ${MAX_MENU_CHANGES + 1} changes`);
  assert.equal(store.rows.size, 0, 'nothing was saved');
  // Without an answer nothing about installation is stored or answered, exactly as before.
  const plain = await (await post(handlers, approve(state, { approve: [{ id: drafts[0].id, unitCents: prices.get(drafts[0].id) }] }))).json();
  assert.equal('goodsInstallationIncluded' in plain.approvals, false);
  assert.equal('goodsInstallationIncluded' in store.rows.get(`${MENU_APPROVALS}/current`), false);
  assert.equal('installationConfirmed' in builderMenu(await readCompositeState(store), { internal: true }).internal, false);
  // A manager cannot answer it; with the builder flag off menu.approve is not a catalog action at all.
  const manager = catalogHandlers({ session: async () => ({ user: 'tylerg', role: 'manager', businessAccess: true }), storage: () => store, now: () => new Date(LATER) });
  assert.equal((await post(manager, approve(await readCompositeState(store), { goodsInstallationIncluded: true }))).status, 403);
  assert.equal((await post(handlers, approve(await readCompositeState(store), { goodsInstallationIncluded: true }), { ...ON_ENV, EGC_QUOTE_BUILDER_ENABLED: '' })).status, 404);
  // A stored answer that is not a boolean fails closed, like any other unverifiable approval.
  assert.throws(() => validateMenuApprovals({ items: {}, revision: 'r1', goodsInstallationIncluded: 'true' }), { code: 'quote_draft_composite_approvals_invalid' });
});

test('a signed goods job held only for the installation decision is released by the owner\'s menu answer while catalog pricing is off', async () => {
  const f = fixture(), approvals = Object.fromEntries(priceCompositeQuote(builderState(), selection(), { complete: true }).breakdown.lines.filter(line => !line.approved).map(line => [line.id, line.unitCents]));
  const store = catalogStore(), seeded = builderState(approvals);
  store.rows.set(`${MENU_APPROVALS}/current`, { id: 'current', revision: 'rev-0', approvals: seeded.approvals.items, menuVersion: seeded.menu.menuVersion, settingsVersion: seeded.settings.settingsVersion });
  const state = () => readCompositeState(store);
  // The estimator's builder quote and its signed handoff (crew/quote-draft.js, crew/gameplan-handoff.js).
  const priced = priceCompositeQuote(await state(), selection(), { complete: true });
  const saved = await saveQuoteDraft(f.store, estimator, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { client: client(1), title: 'Garage reset', scope: 'Shelving and storage.', line_items: priced.lineItems, valid_until: '2026-10-30', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: selection() } }, NOW, { env: ON_ENV, compositeState: state });
  const job = f.job(saved.job.id), lines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
  const signed = await saveWalkthroughHandoff(f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision,
    plan: signedPlan(1, { total: priced.totalCents / 100, quote: { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion } }) }, NOW, { env: ON_ENV, compositeState: state });
  assert.deepEqual(signed.pricing, { source: 'builder', ready: false, pending: ['Shelving and storage installation'] });
  // The estimator's send gate says the same.
  const quotes = quoteDraftHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW), compositeState: state, stripe: () => null });
  const held = () => ({ ...f.store, heldJobIds: async limit => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).slice(0, limit) });
  const handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held });
  const response = await post(handlers, approve(await state(), { goodsInstallationIncluded: true })), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.heldJobs, { released: [signed.job.id], waiting: 0, more: false });
  const released = f.job(signed.job.id);
  assert.deepEqual([released.pricesPendingApproval, released.customerPortalInvitationRequestedAt, released.pricesRelease.source, released.pricesRelease.gate], [null, LATER, 'menu.approve', 'approved_prices']);
  const builder = await (await quotes.get({ request: new Request(`${ORIGIN}/api/quote-draft?view=builder`), env: ON_ENV })).json();
  assert.deepEqual(builder.installation, { included: true }, 'the estimator\'s builder no longer warns about installation');
});
