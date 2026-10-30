// Owner decision 2026-10-30 ("hard code the pricing"): every pricing-menu price that was a draft (128 goods and 33
// services on menu 2026-10-16.2) is approved in code at the amount it had, in functions/_data/pricing-menu.json
// (menu.approvals). Builder quotes using them are sent, signed jobs are no longer held for them, and the customer can
// approve and pay. An amount the owner approves in the Hub (Menu prices) still overrides one approved in code; a price the
// owner has not approved (a later import's new item, a goods markup change) is a draft again. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { approvalRefusal, builderMenu, compositeApproval, menuItemIdentity, menuPrices, priceCompositeQuote, validatePricingMenu } from '../functions/_lib/composite-quote.js';
import { bundledPricingMenu, mutateCatalog } from '../functions/_lib/catalog-store.js';
import { releaseAllHeldHandoffs, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { payable } from '../functions/_lib/customer-payments.js';
import { unsentQuoteDraft } from '../functions/_lib/quote-model.js';
import { DRAFT_MENU, LATER, NOW, ON_ENV, SHIPPED_MENU, TOTES, builderState, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const shipped = (approvals = {}, extra = {}) => ({ ...builderState(approvals, extra), menu: SHIPPED_MENU });
const items = menu => [...menu.services, ...menu.products];
const pick = (name, quantity = 1) => ({ id: menuItem(name).id, quantity });
const SHELF = SHIPPED_MENU.products.find(item => item.id === 'hd-100006678'), MATTRESS = menuItem('Mattress'), TWO_CAR = menuItem('Two-car garage base'), TRUCK = menuItem('Full truck load');

test('every menu price is owner-approved: 161 in code (2026-10-30) and the four truck loads in the menu, none of them changed', () => {
  assert.deepEqual(bundledPricingMenu(), SHIPPED_MENU, 'the Worker prices from this menu');
  const { approvals } = SHIPPED_MENU;
  assert.deepEqual([approvals.approvedBy, approvals.approvedOn, SHIPPED_MENU.menuVersion], ['owner', '2026-10-30', '2026-10-16.3']);
  assert.match(approvals.note, /owner's decision of 2026-10-30 \("hard code the pricing"\).*An amount the owner approves in the Hub \(Menu prices\) overrides it/);
  const now = menuPrices(shipped()), before = menuPrices(builderState());
  assert.deepEqual(items(SHIPPED_MENU).filter(item => !now.get(item.id).approved).map(item => item.id), [], 'no draft price is left');
  assert.deepEqual([items(SHIPPED_MENU).filter(item => now.get(item.id).source === 'code').length, items(SHIPPED_MENU).filter(item => now.get(item.id).source === 'menu').map(item => item.menuId)],
    [161, ['EGC-023', 'EGC-024', 'EGC-025', 'EGC-026']]);
  for (const item of items(SHIPPED_MENU)) {
    assert.equal(now.get(item.id).unitCents, before.get(item.id).unitCents, `${item.id}: approving it changed no amount`);
    const entry = approvals.items[item.id];
    if (item.status === 'approved') { assert.equal(entry, undefined, `${item.id} keeps its fixed amount`); continue; }
    assert.deepEqual(entry, { unitCents: before.get(item.id).unitCents, identity: menuItemIdentity(item) }, `${item.id} is approved for this item at its amount`);
  }
  assert.deepEqual([now.get(MATTRESS.id).reason, now.get(SHELF.id).reason], ['Owner-approved price (approved in code on 2026-10-30).', 'Owner-approved price (approved in code on 2026-10-30).']);
  // The labor rate is untouched: the owner's $53.00 per man-hour unless the owner sets another in the Hub.
  assert.deepEqual([builderMenu(shipped()).labor.rateCents, builderMenu(shipped()).labor.source], [5300, 'default']);
});

test('a builder quote with every kind of item is sendable at once; the same quote on a draft menu is still held', () => {
  const quote = selection({ removal: [pick('Two-car garage base'), pick('Full truck load'), pick('Mattress', 2), pick('Stairs'), pick('Deep cleaning, two-car')], shelving: [{ id: SHELF.id, quantity: 2 }], storage: [{ id: TOTES.id, quantity: 1 }] });
  const priced = priceCompositeQuote(shipped(), quote, { complete: true });
  assert.deepEqual(priced.approval, { ready: true, blocked: [] });
  assert.ok(priced.breakdown.lines.every(line => line.approved), 'every line is approved');
  assert.deepEqual(compositeApproval(priced.breakdown, shipped()), { ready: true, blocked: [] }, 'the send gate passes (quote-draft.js send preview and send)');
  // The draft rules are unchanged for a price the owner has not approved.
  const draft = priceCompositeQuote(builderState(), quote, { complete: true });
  assert.equal(draft.approval.ready, false);
  assert.equal(approvalRefusal(draft.approval).code, 'quote_draft_composite_prices_unapproved');
});

test('an amount the owner approves in the Hub overrides the one approved in code, and revoking it falls back to code', () => {
  const owned = menuPrices(shipped({ [MATTRESS.id]: 8000, [TWO_CAR.id]: 55000 }));
  assert.deepEqual([owned.get(MATTRESS.id).unitCents, owned.get(MATTRESS.id).source, owned.get(MATTRESS.id).codeCents], [8000, 'owner', 7000]);
  assert.deepEqual([owned.get(TWO_CAR.id).unitCents, owned.get(TWO_CAR.id).source], [55000, 'owner'], 'a cleaning-only base amount the owner sets wins');
  const priced = priceCompositeQuote(shipped({ [MATTRESS.id]: 8000 }), selection({ removal: [pick('Full truck load'), pick('Mattress')], shelving: [], storage: [], labor: null }), { complete: true });
  assert.deepEqual([priced.lineItems.find(line => line.id === 'removal-special').totalCents, priced.approval.ready], [8000, true]);
  // A quote saved at the code amount before the owner's change is saved again (no owner approval asked).
  const older = priceCompositeQuote(shipped(), selection({ removal: [pick('Full truck load'), pick('Mattress')], shelving: [], storage: [], labor: null }), { complete: true });
  const resave = compositeApproval(older.breakdown, shipped({ [MATTRESS.id]: 8000 }));
  assert.deepEqual(resave.blocked.map(row => [row.id, row.resave === true]), [[MATTRESS.id, true]]);
  const revoked = menuPrices(shipped()).get(MATTRESS.id);
  assert.deepEqual([revoked.unitCents, revoked.approved, revoked.source], [7000, true, 'code']);
  // The owner and managers see what a revoked Hub approval falls back to; an estimator sees no such detail.
  assert.equal(builderMenu(shipped({ [MATTRESS.id]: 8000 }), { internal: true }).services.find(item => item.id === MATTRESS.id).codeCents, 7000);
  assert.equal('codeCents' in builderMenu(shipped({ [MATTRESS.id]: 8000 })).services.find(item => item.id === MATTRESS.id), false);
});

test('a goods price approved in code holds only at its amount: a markup change or a re-import makes it a draft again', () => {
  const at = settings => menuPrices(shipped({}, settings)).get(SHELF.id);
  assert.deepEqual([at({}).unitCents, at({}).approved, at({}).source], [11570, true, 'code']);
  const moved = at({ goodsMarkup: 1.5 });
  assert.deepEqual([moved.unitCents, moved.approved, moved.source], [13350, false, 'draft']);
  assert.match(moved.reason, /^The owner approved \$115\.70 per pack in code on 2026-10-30, but the current price is \$133\.50; the owner must approve the new price\.$/);
  assert.deepEqual([menuPrices(shipped({ [SHELF.id]: 13350 }, { goodsMarkup: 1.5 })).get(SHELF.id).approved, menuPrices(shipped({ [SHELF.id]: 13350 }, { goodsMarkup: 1.5 })).get(SHELF.id).source], [true, 'owner'], 'the owner approves the new price in the Hub');
  const repacked = { ...SHIPPED_MENU, products: SHIPPED_MENU.products.map(item => item.id === SHELF.id ? { ...item, unitsPerPack: 2 } : item) };
  const stale = menuPrices({ ...shipped(), menu: repacked }).get(SHELF.id);
  assert.deepEqual([stale.approved, stale.source], [false, 'draft']);
  assert.match(stale.reason, /earlier version of this menu item; a menu re-import changed it/);
  const repurposed = { ...SHIPPED_MENU, services: SHIPPED_MENU.services.map(item => item.id === MATTRESS.id ? { ...item, name: 'Futon', basis: { ...item.basis, key: 'Couch / sofa / loveseat' } } : item) };
  assert.deepEqual([menuPrices({ ...shipped(), menu: repurposed }).get(MATTRESS.id).approved, menuPrices({ ...shipped(), menu: repurposed }).get(MATTRESS.id).source], [false, 'draft']);
});

test('the menu\'s approvals in code are validated: the owner only, items on the menu, never over a fixed amount', () => {
  const bad = change => { const menu = structuredClone(SHIPPED_MENU); change(menu); return () => validatePricingMenu(menu); };
  assert.throws(bad(menu => { menu.approvals.approvedBy = 'estimator'; }), { code: 'composite_menu_invalid' });
  assert.throws(bad(menu => { menu.approvals.approvedOn = 'today'; }), { code: 'composite_menu_invalid' });
  assert.throws(bad(menu => { menu.approvals.items['egc-999'] = { unitCents: 100, identity: 'x' }; }), /must name an item on this menu/);
  assert.throws(bad(menu => { menu.approvals.items[TRUCK.id] = { unitCents: 80000, identity: menuItemIdentity(TRUCK) }; }), /fixed amount/);
  assert.throws(bad(menu => { menu.approvals.items[MATTRESS.id].unitCents = 0; }), { code: 'composite_menu_invalid' });
  assert.throws(bad(menu => { menu.approvals.items[MATTRESS.id].extra = true; }), { code: 'composite_menu_invalid' });
  assert.throws(bad(menu => { menu.approvals.extra = true; }), { code: 'composite_menu_invalid' });
  assert.doesNotThrow(() => validatePricingMenu(structuredClone(DRAFT_MENU)), 'a menu without approvals in code is valid');
});

test('the owner can approve another amount for a price approved in code from Menu prices; a fixed truck amount stays refused', async () => {
  const rows = new Map();
  const store = { read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), commit: async writes => { for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...structuredClone(write.patch), revision: 'r1' }); return {}; } };
  const state = shipped(), base = { action: 'menu.approve', expectedRevision: null, menuVersion: state.menu.menuVersion, settingsVersion: state.settings.settingsVersion, revoke: [] };
  const saved = await mutateCatalog(store, owner, { ...base, requestId: randomUUID(), approve: [{ id: MATTRESS.id, unitCents: 8000 }] }, LATER, { menuApprovals: true, compositeState: async () => state });
  assert.deepEqual([saved.approvals.items[MATTRESS.id].unitCents, saved.approvals.items[MATTRESS.id].basis], [8000, { draftCents: 7000 }]);
  await assert.rejects(mutateCatalog(store, owner, { ...base, requestId: randomUUID(), approve: [{ id: TRUCK.id, unitCents: 80000 }] }, LATER, { menuApprovals: true, compositeState: async () => state }), { code: 'catalog_menu_item_approved' });
});

test('a job held at signing for draft prices is released by the new menu version at the amounts signed, and the customer can approve and pay', async () => {
  const f = fixture(), draft = builderState(), priced = priceCompositeQuote(draft, selection(), { complete: true });
  assert.equal(priced.approval.ready, false);
  const lines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
  const signed = await saveWalkthroughHandoff(f.store, owner, { actorId: owner.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r',
    plan: signedPlan(1, { total: priced.totalCents / 100, quote: { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion } }) }, NOW, { env: ON_ENV, compositeState: async () => draft });
  const held = f.job(signed.job.id);
  assert.equal(held.pricesPendingApproval.status, 'pending');
  assert.equal(unsentQuoteDraft(held), true, 'held: no customer surface shows or charges it');
  assert.throws(() => payable(held), { code: 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE' });
  // Deployed: the menu approves those prices in code. The Hub's held-jobs sweep (the first open after the deploy) releases it.
  const store = { ...f.store, heldJobIds: async (limit, after = '') => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).sort().filter(id => !after || id > after).slice(0, limit) };
  const run = await releaseAllHeldHandoffs(store, owner, LATER, { env: ON_ENV, compositeState: async () => shipped(), source: 'menu.version', budget: 40 });
  assert.deepEqual([run.released, run.waiting, run.complete], [[signed.job.id], 0, true]);
  const job = f.job(signed.job.id);
  assert.deepEqual([job.pricesPendingApproval, job.total, job.customerPortalInvitationRequestedAt, job.pricesRelease.gate], [null, priced.totalCents / 100, LATER, 'approved_prices'], 'released at the amounts signed');
  assert.equal(unsentQuoteDraft(job), false);
  const due = payable(job);
  assert.deepEqual([due.purpose, Math.round(due.dueNow * 100)], ['deposit', Math.round(priced.totalCents / 4)], 'the 25% deposit opens for card payment');
});
