import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BUILDER_STEPS, BUILDER_SECTIONS, INSTALLATION_ID, MAX_CHARGED_LINES, approvalRefusal, builderMenu, compositeApproval, compositeCatalogCategory, menuItemIdentity, menuPrices, priceCompositeQuote, quoteBreakdown, sectionOfCatalogCategory, validateMenuApprovals, validatePricingMenu } from '../functions/_lib/composite-quote.js';
import { bundledPricingMenu, catalogStorage, MAX_MENU_CHANGES, MENU_APPROVALS, mutateCatalog, readCompositeState } from '../functions/_lib/catalog-store.js';
import { lineItemCatalogCategories } from '../functions/_lib/funnel-dimensions.js';
import { catalogHandlers } from '../functions/api/catalog.js';
import { DEFAULT_GOODS_MARKUP, goodsMarkupOf, validatePricingSettings } from '../functions/_lib/catalog.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { checkCommitted } from '../scripts/import-pricing-menu.mjs';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const menu = readJson('../functions/_data/pricing-menu.json');
const defaults = readJson('../functions/_data/pricing-settings.defaults.json');
const walkthrough = walkthroughPricing(walkthroughServiceItems());
const state = ({ settings = {}, approvals = {} } = {}) => ({ menu, settings: { ...structuredClone(defaults), ...settings }, walkthrough, approvals: { items: approvals, revision: approvals && Object.keys(approvals).length ? 'a1' : null } });
const product = (section, group) => menu.products.find(item => item.section === section && (!group || item.group === group));
const shelf = menu.products.find(item => item.id === 'hd-100006678');
const service = name => menu.services.find(item => item.name === name);
const TRUCK = service('Full truck load'), HALF = service('Half load'), TWO_CAR = service('Two-car garage base'), ONE_CAR = service('One-car garage base'), MATTRESS = service('Mattress'), STAIRS = service('Stairs');
const DEEP_TWO = service('Deep cleaning, two-car'), DEEP_THREE = service('Deep cleaning, three-car'), WASH = service('Pressure washing, one-car'), QUARTER = service('Quarter load');
const pick = (item, quantity = 1) => ({ id: item.id, quantity });
// D12: every builder quote carries labor; a complete quote here carries 6 man-hours as saved (6 x $40.00 = $240.00) in a
// medium-full garage. A step preview sends none.
const LABOR = { manHours: 6, fullness: 'medium' }, LABOR_CENTS = 24000;
const descriptor = ({ steps = BUILDER_STEPS, removal = [], shelving = [], storage = [], s = state(), labor = steps.length === BUILDER_STEPS.length ? LABOR : undefined } = {}) => ({ menuVersion: menu.menuVersion, settingsVersion: s.settings.settingsVersion, steps: [...steps], removal, shelving, storage, ...(labor ? { labor: structuredClone(labor) } : {}) });
const costFree = value => assert.doesNotMatch(JSON.stringify(value), /retailPerPackCents|"split"|productCents|markupCents|laborCents|goodsMarkup|basis/, 'no cost, multiplier or cost split');
// An owner approval as menu.approve stores it: the amount and the identity of the item it was given for.
const approve = (item, unitCents) => ({ unitCents, identity: menuItemIdentity(item) });
const INSTALLED = { goodsInstallationIncluded: true };

test('the shipped pricing menu validates, matches its generated module and holds public product data only', () => {
  assert.doesNotThrow(() => validatePricingMenu(structuredClone(menu)));
  assert.deepEqual(checkCommitted(), { ok: true });
  assert.deepEqual(bundledPricingMenu(), menu);
  assert.ok(Object.isFrozen(bundledPricingMenu().products[0]), 'the shared menu cannot be mutated');
  assert.equal(menu.products.length, 128);
  assert.equal(new Set(menu.products.map(item => item.sku)).size, 128, 'one entry per Home Depot internet SKU');
  assert.ok(menu.products.every(item => item.status === 'draft' && item.evidence.checkedOn === '2026-10-16' && item.retailer === 'The Home Depot'), 'every product is a DRAFT with the 2026-10-16 retail evidence');
  assert.ok(menu.products.every(item => /^https:\/\/www\.homedepot\.com\//.test(item.productUrl) && Number.isSafeInteger(item.retailPerPackCents) && item.unitsPerPack >= 1));
  assert.deepEqual(menu.services.filter(item => item.status === 'approved').map(item => [item.menuId, item.approvedPriceCents]), [['EGC-026', 75000]], 'the $750 full truck is the only approved price');
  const text = readFileSync(new URL('../functions/_data/pricing-menu.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /mail\.google|@easygaragecleaning|commission|margin|cost\s*\/\s*\.?60|Proposed|Original30|Sensitivity|Owner review|\bCAC\b|\bwages?\b/i, 'no margins, proposed prices, commission, CAC, wage or private links');
  // Every service's draft amount resolves against today's walkthrough tables (no 503 for a broken mapping).
  const prices = menuPrices(state());
  for (const item of menu.services) assert.ok(Number.isSafeInteger(prices.get(item.id).unitCents), item.name);
  assert.equal(prices.get(MATTRESS.id).unitCents, walkthrough.special.Mattress * 100);
  assert.equal(prices.get(TWO_CAR.id).unitCents, walkthrough.sizeBase[2] * 100);
  assert.equal(prices.get(HALF.id).unitCents, 37500, 'a partial load is a proportional draft of the approved full truck');
  // Every builder group is used and every product sits in the shelving or extra storage step.
  const groups = new Set(menu.products.map(item => item.group));
  for (const group of BUILDER_SECTIONS.slice(1).flatMap(section => section.groups.map(entry => entry.id))) assert.ok(groups.has(group), group);
});

test('the builder always prices removal first, then shelving, then extra storage, and refuses a step out of order', () => {
  const s = state(), storage = product('storage', 'overhead');
  const priced = priceCompositeQuote(s, descriptor({ storage: [pick(storage)], shelving: [pick(shelf, 2)], removal: [pick(STAIRS), pick(TRUCK), pick(TWO_CAR)] }), { complete: true });
  assert.deepEqual(priced.lineItems.map(line => line.id), ['removal-base', 'removal-junk-full', 'removal-access', 'shelving-goods', 'storage-goods', 'labor'], 'the Labor line comes last');
  assert.deepEqual(priced.breakdown.sections.map(section => section.id), ['removal', 'shelving', 'storage']);
  assert.deepEqual(priced.steps.map(step => [step.id, step.subtotalCents, step.runningTotalCents]), [
    ['removal', 97500 + 75000 + 19000, 191500], ['shelving', 23140, 214640], ['storage', priced.breakdown.sections[2].subtotalCents, priced.totalCents - LABOR_CENTS], ['labor', LABOR_CENTS, priced.totalCents]]);
  for (const steps of [['shelving'], ['removal', 'storage'], ['storage', 'shelving', 'removal'], [], ['removal', 'shelving', 'storage', 'removal']]) {
    assert.throws(() => priceCompositeQuote(s, descriptor({ steps, removal: [pick(TRUCK)] })), { code: 'quote_draft_composite_order' }, JSON.stringify(steps));
  }
  assert.throws(() => priceCompositeQuote(s, descriptor({ steps: ['removal', 'shelving'], removal: [pick(TRUCK)], storage: [pick(storage)] })), { code: 'quote_draft_composite_order' }, 'storage cannot be added before its step');
  assert.throws(() => priceCompositeQuote(s, descriptor({ steps: ['removal'], removal: [pick(TRUCK)], shelving: [pick(shelf)] })), { code: 'quote_draft_composite_order' });
  // A running total may price the first steps only; a save needs all three.
  const running = priceCompositeQuote(s, descriptor({ steps: ['removal'], removal: [pick(TRUCK)] }));
  assert.deepEqual(running.steps.map(step => step.id), ['removal']);
  assert.throws(() => priceCompositeQuote(s, descriptor({ steps: ['removal', 'shelving'], removal: [pick(TRUCK)] }), { complete: true }), { code: 'quote_draft_composite_incomplete' });
  assert.throws(() => priceCompositeQuote(s, descriptor({ shelving: [pick(storage)], removal: [pick(TRUCK)] })), { code: 'quote_draft_composite_wrong_step' }, 'a storage product is not shelving');
  assert.throws(() => priceCompositeQuote(s, descriptor({ storage: [pick(shelf)], removal: [pick(TRUCK)] })), { code: 'quote_draft_composite_wrong_step' });
  assert.throws(() => priceCompositeQuote(s, descriptor({ removal: [pick(shelf)] })), { code: 'quote_draft_composite_invalid_selection' }, 'a product id is never a removal item');
});

test('the server prices every line from its own menu, settings and approvals; the browser sends no prices', () => {
  const s = state(), priced = priceCompositeQuote(s, descriptor({ removal: [pick(HALF), pick(TRUCK, 2), pick(MATTRESS, 2)], shelving: [pick(shelf, 3)] }), { complete: true });
  const line = id => priced.lineItems.find(entry => entry.id === id);
  assert.deepEqual([line('removal-junk-full').quantity, line('removal-junk-full').unitCents, line('removal-junk-full').totalCents], [2, 75000, 150000]);
  assert.deepEqual([line('removal-junk-partial').totalCents, line('removal-special').totalCents, line('removal-special').description], [37500, 14000, 'Mattress × 2']);
  assert.deepEqual([line('shelving-goods').quantity, line('shelving-goods').unitCents, line('shelving-goods').totalCents], [1, 34710, 34710], 'goods sell at the public retail pack price × 1.30, rolled into one shelving line');
  assert.equal(line('shelving-goods').description, `${shelf.name} × 3 packs`);
  assert.deepEqual(priced.breakdown.lines.find(entry => entry.id === shelf.id).unitCents, 11570, 'the breakdown keeps the per-pack price');
  assert.equal(priced.totalCents, 150000 + 37500 + 14000 + 34710 + LABOR_CENTS);
  assert.deepEqual(line('shelving-goods').catalog, { itemId: 'menu-shelving', version: menu.menuVersion });
  // The saved Hub job keeps the goods cost split of the step; previews and the breakdown never carry it.
  assert.deepEqual(priced.storedLineItems.find(entry => entry.id === 'shelving-goods').split, { productCents: 26700, laborCents: 0, laborMinutes: 0, markupCents: 8010, disposalCents: 0 });
  costFree({ lineItems: priced.lineItems, breakdown: priced.breakdown, steps: priced.steps, approval: priced.approval });
  // Extra keys (a client price) are refused rather than trusted.
  assert.throws(() => priceCompositeQuote(s, { ...descriptor({ removal: [pick(TRUCK)] }), removal: [{ id: TRUCK.id, quantity: 1, unitCents: 1 }] }), { code: 'quote_draft_composite_invalid_selection' });
  assert.throws(() => priceCompositeQuote(s, { ...descriptor({ removal: [pick(TRUCK)] }), totalCents: 1 }), { code: 'quote_draft_composite_invalid_selection' });
  assert.throws(() => priceCompositeQuote(s, { ...descriptor({ removal: [pick(TRUCK)] }), menuVersion: '2026-01-01.1' }), { code: 'quote_draft_composite_version_changed' });
  assert.throws(() => priceCompositeQuote(s, { ...descriptor({ removal: [pick(TRUCK)] }), settingsVersion: 'older' }), { code: 'quote_draft_composite_version_changed' });
  assert.throws(() => priceCompositeQuote(s, descriptor({ removal: [] })), { code: 'quote_draft_composite_empty' });
});

test('the goodsMarkup pricing setting prices goods (default 1.30) and is validated like every setting', () => {
  assert.equal(DEFAULT_GOODS_MARKUP, 1.3);
  assert.equal(defaults.goodsMarkup, undefined, 'the shipped settings leave it unset, so the default applies and their output is unchanged');
  assert.deepEqual(goodsMarkupOf({}), { multiplier: 1.3, basisPoints: 13000 }, 'a saved document without the field uses the default');
  const { goodsMarkup, ...older } = structuredClone(defaults);
  assert.doesNotThrow(() => validatePricingSettings(older), 'settings saved before the field existed stay valid');
  for (const bad of [0.99, 5.01, 1.23456, '1.3', null]) assert.throws(() => validatePricingSettings({ ...structuredClone(defaults), goodsMarkup: bad }), { code: 'catalog_settings_invalid' }, String(bad));
  const at = markup => priceCompositeQuote(state({ settings: { goodsMarkup: markup } }), descriptor({ shelving: [pick(shelf)], removal: [pick(TRUCK)] })).lineItems.find(line => line.kind === 'product').unitCents;
  assert.equal(at(1.3), 11570);
  assert.equal(at(1.2345), 10987, 'a synthetic 1.2345 multiplier: $89.00 × 1.2345 = $109.8705, half_up_cent gives $109.87 and ceil_cent $109.88');
  assert.equal(at(1), 8900);
  const ceil = priceCompositeQuote(state({ settings: { goodsMarkup: 1.2345, roundingRule: 'ceil_cent' } }), descriptor({ shelving: [pick(shelf)], removal: [pick(TRUCK)] }));
  assert.equal(ceil.lineItems.find(line => line.kind === 'product').unitCents, 10988);
  assert.equal(builderMenu(state(), { internal: true }).internal.goodsMarkup, 1.3);
});

test('draft prices are priced and saved but block sending with a reason per line; the approved $750 full truck sends', () => {
  const draft = priceCompositeQuote(state(), descriptor({ removal: [pick(TWO_CAR), pick(TRUCK), pick(QUARTER), pick(MATTRESS)], shelving: [pick(shelf)] }), { complete: true });
  assert.equal(draft.approval.ready, false);
  assert.deepEqual(draft.approval.blocked.map(row => row.id), [TWO_CAR.id, QUARTER.id, MATTRESS.id, shelf.id], 'everything but the full truck and the labor waits for the owner; installation is billed through labor');
  assert.match(draft.approval.blocked[0].reason, /^Two-car garage base: draft price \$975\.00 is the walkthrough's historical full-service base, which already included hauling; the owner sets the cleaning-only amount\.$/);
  assert.match(draft.approval.blocked[1].reason, /^Quarter load: draft price \$187\.50, not yet approved by the owner\.$/);
  assert.match(draft.approval.blocked[3].reason, /per pack, not yet approved by the owner/);
  const refusal = approvalRefusal(draft.approval);
  assert.equal(refusal.code, 'quote_draft_composite_prices_unapproved');
  assert.equal(refusal.status, 409);
  assert.match(refusal.message, /4 prices the owner has not approved: Two-car garage base, Quarter load, Mattress, HDX plastic shelving[^.]*\. It stays saved/);
  assert.equal(refusal.details.unapproved.length, 4);
  const truck = priceCompositeQuote(state(), descriptor({ removal: [pick(TRUCK, 3)] }), { complete: true });
  assert.deepEqual([truck.totalCents, truck.approval.ready, truck.breakdown.lines[0].approved], [225000 + LABOR_CENTS, true, true], 'the $750 truck and the owner\'s $40.00 labor rate are both approved');
  assert.deepEqual(compositeApproval(truck.breakdown, state()), { ready: true, blocked: [] });
  assert.equal(compositeApproval(null, state()).ready, false, 'a missing breakdown never sends');
});

test('owner approvals: a service is approved at the owner amount, a product only at cost × goodsMarkup, and a send re-checks them', () => {
  const approvals = { [MATTRESS.id]: approve(MATTRESS, 8000), [TWO_CAR.id]: approve(TWO_CAR, 97500), [shelf.id]: approve(shelf, 11570) };
  const approved = priceCompositeQuote(state({ approvals, settings: INSTALLED }), descriptor({ removal: [pick(TWO_CAR), pick(MATTRESS, 2)], shelving: [pick(shelf)] }), { complete: true });
  assert.equal(approved.approval.ready, true);
  assert.equal(approved.lineItems.find(line => line.id === 'removal-special').totalCents, 16000, 'the owner-approved service amount is the price');
  // A draft saved earlier sends once the owner approves exactly its prices (no re-save), and is blocked again
  // when an approval is revoked or the goods multiplier moves the product price.
  const draft = priceCompositeQuote(state(), descriptor({ removal: [pick(TWO_CAR)], shelving: [pick(shelf)] }), { complete: true });
  assert.equal(compositeApproval(draft.breakdown, state()).ready, false);
  assert.deepEqual(compositeApproval(draft.breakdown, state({ approvals })), { ready: true, blocked: [] }, 'approved prices send: installation is billed through the Labor line');
  assert.equal(compositeApproval(draft.breakdown, state({ approvals, settings: INSTALLED })).ready, true);
  const moved = compositeApproval(draft.breakdown, state({ approvals, settings: { ...INSTALLED, goodsMarkup: 1.5 } }));
  assert.deepEqual(moved.blocked.map(row => row.id), [shelf.id]);
  assert.match(moved.blocked[0].reason, /owner approved \$115\.70 per pack, but the current price is \$133\.50/);
  const changed = compositeApproval(draft.breakdown, state({ approvals: { ...approvals, [TWO_CAR.id]: approve(TWO_CAR, 99000) }, settings: INSTALLED }));
  assert.match(changed.blocked[0].reason, /The owner approved \$990\.00 for Two-car garage base, but this quote has \$975\.00\. Save the quote again/);
  assert.throws(() => validateMenuApprovals({ items: { [shelf.id]: { unitCents: 0 } }, revision: 'r' }), { code: 'quote_draft_composite_approvals_invalid' });
  assert.throws(() => validateMenuApprovals({ items: { 'not-a-menu-id': { unitCents: 100 } }, revision: 'r' }), { code: 'quote_draft_composite_approvals_invalid' });
  assert.throws(() => validateMenuApprovals({ items: { [shelf.id]: { unitCents: 100, identity: 7 } }, revision: 'r' }), { code: 'quote_draft_composite_approvals_invalid' });
});

test('an approval names the item it was given for: a re-import that repurposes an id or repacks a SKU puts it back into draft', () => {
  const approvals = { [MATTRESS.id]: approve(MATTRESS, 8000), [shelf.id]: approve(shelf, 11570) };
  assert.deepEqual([menuPrices(state({ approvals })).get(MATTRESS.id).approved, menuPrices(state({ approvals })).get(shelf.id).approved], [true, true]);
  assert.equal(menuPrices(state({ approvals: { [MATTRESS.id]: { unitCents: 8000 } } })).get(MATTRESS.id).approved, false, 'an approval without the item identity never counts');
  // EGC-027 re-imported as another special item: the owner's $80 for a mattress does not carry over.
  const repurposed = { ...menu, services: menu.services.map(item => item.id === MATTRESS.id ? { ...item, name: 'Futon', basis: { ...item.basis, key: 'Couch / sofa / loveseat' } } : item) };
  const stale = menuPrices({ ...state({ approvals }), menu: repurposed }).get(MATTRESS.id);
  assert.deepEqual([stale.approved, stale.source, stale.unitCents], [false, 'draft', walkthrough.special['Couch / sofa / loveseat'] * 100]);
  assert.match(stale.reason, /The owner approved \$80\.00 for an earlier version of this menu item; a menu re-import changed it/);
  const repacked = { ...menu, products: menu.products.map(item => item.id === shelf.id ? { ...item, unitsPerPack: 2 } : item) };
  const pack = menuPrices({ ...state({ approvals }), menu: repacked }).get(shelf.id);
  assert.deepEqual([pack.approved, pack.unitCents], [false, 11570], 'the same SKU and price but a new pack size is a new approval');
  assert.match(pack.reason, /earlier version of this menu item/);
  // A saved quote whose item changed is blocked at send.
  const saved = priceCompositeQuote(state({ approvals, settings: INSTALLED }), descriptor({ removal: [pick(MATTRESS)] }), { complete: true });
  assert.equal(saved.approval.ready, true);
  assert.deepEqual(compositeApproval(saved.breakdown, { ...state({ approvals, settings: INSTALLED }), menu: repurposed }).blocked.map(row => row.id), [MATTRESS.id]);
});

test('installation is billed through the Labor line (D12); only a quote saved before labor existed waits for the owner\'s installation answer', () => {
  for (const bad of ['yes', 1, null]) assert.throws(() => validatePricingSettings({ ...structuredClone(defaults), goodsInstallationIncluded: bad }), { code: 'catalog_settings_invalid' }, String(bad));
  assert.doesNotThrow(() => validatePricingSettings({ ...structuredClone(defaults), goodsInstallationIncluded: false }));
  const approvals = { [shelf.id]: approve(shelf, 11570) }, goods = descriptor({ removal: [pick(TRUCK)], shelving: [pick(shelf)] });
  // With labor the goods quote is ready as soon as its prices are approved: no installation answer is asked for.
  const ready = priceCompositeQuote(state({ approvals }), goods, { complete: true });
  assert.deepEqual(ready.approval, { ready: true, blocked: [] });
  assert.match(ready.lineItems.at(-1).description, /including installing the shelving and storage/);
  assert.equal(priceCompositeQuote(state(), descriptor({ removal: [pick(TRUCK)] }), { complete: true }).lineItems.at(-1).description, 'Crew time on site, billed per man-hour.', 'removal alone has no installation to mention');
  // installation.included: the owner's answer (installation included in the goods price); the Labor line bills it otherwise.
  assert.deepEqual(builderMenu(state()).installation, { included: false, billedAs: 'labor' });
  assert.deepEqual(builderMenu(state({ settings: INSTALLED })).installation, { included: true, billedAs: 'labor' });
  assert.equal(builderMenu(state({ settings: INSTALLED }), { internal: true }).internal.goodsInstallationIncluded, true);
  // A breakdown saved before the Labor line existed: an unsent draft must be saved again (with labor); a job the
  // customer already signed that way (requireLabor:false) keeps the earlier rule and waits for the installation answer.
  const { labor, ...older } = ready.breakdown;
  assert.deepEqual(compositeApproval(older, state({ approvals })).blocked.map(row => row.id), ['labor', INSTALLATION_ID]);
  assert.match(compositeApproval(older, state({ approvals })).blocked[0].reason, /no Labor line\. Every builder quote charges labor: the estimated man-hours × \$40\.00 per man-hour/);
  const signed = compositeApproval(older, state({ approvals }), { requireLabor: false });
  assert.deepEqual(signed.blocked.map(row => [row.id, row.unitCents]), [[INSTALLATION_ID, null]]);
  assert.match(signed.blocked[0].reason, /saved before builder quotes had a Labor line/);
  assert.deepEqual(compositeApproval(older, state({ approvals, settings: INSTALLED }), { requireLabor: false }), { ready: true, blocked: [] });
  assert.deepEqual(compositeApproval(older, state({ approvals: { ...approvals }, settings: {} }), { requireLabor: false }).ready, false);
});

test('removal rules: one base, one partial load, sized deep clean, one-car pressure wash, and the 12 charged-line limit', () => {
  const s = state(), price = removal => priceCompositeQuote(s, descriptor({ removal }));
  assert.throws(() => price([pick(TWO_CAR), pick(ONE_CAR)]), { code: 'quote_draft_composite_invalid_selection' });
  assert.throws(() => price([pick(HALF), pick(QUARTER)]), { code: 'quote_draft_composite_invalid_selection' });
  assert.throws(() => price([pick(HALF, 2)]), { code: 'quote_draft_composite_invalid_selection' });
  assert.throws(() => price([pick(TWO_CAR), pick(DEEP_THREE)]), /must match the garage cleaning base size/);
  assert.throws(() => price([pick(TWO_CAR), pick(WASH)]), /one-car garage cleaning base only/);
  assert.doesNotThrow(() => price([pick(ONE_CAR), pick(WASH)]));
  assert.doesNotThrow(() => price([pick(TWO_CAR), pick(DEEP_TWO)]));
  assert.throws(() => price([pick(TRUCK, 21)]), /at most 20 full truck loads/);
  assert.throws(() => price([pick(STAIRS, 2)]), /quoted once/);
  // Special-handling and access items roll into one line each, so a full removal fits on the quote.
  const specials = menu.services.filter(item => item.group === 'special');
  const full = price([pick(TWO_CAR), pick(TRUCK), pick(HALF), ...specials.map(item => pick(item)), pick(STAIRS), pick(service('Long carry')), pick(DEEP_TWO)]);
  assert.equal(full.lineItems.length, 7, 'six removal lines and the Labor line');
  assert.equal(full.breakdown.lines.length, 3 + specials.length + 2 + 1, 'the breakdown keeps every item: base, two loads, each special item, both access items, the deep clean');
  // Each goods step is one line too: the largest removal step with shelving and a product from every storage group fits.
  const shelves = menu.products.filter(item => item.section === 'shelving').slice(0, 3).map(item => pick(item, 2));
  const storage = BUILDER_SECTIONS[2].groups.flatMap(group => menu.products.filter(item => item.group === group.id).slice(0, 2).map(item => pick(item)));
  const biggest = priceCompositeQuote(s, descriptor({ removal: [pick(ONE_CAR), pick(TRUCK, 2), pick(HALF), pick(MATTRESS), ...specials.slice(1, 4).map(item => pick(item)), pick(STAIRS), pick(service('Long carry')),
    pick(WASH), pick(service('Deep cleaning, one-car')), pick(service('Pest-waste cleanup')), pick(service('Mouse trapping'))], shelving: shelves, storage }), { complete: true });
  assert.deepEqual(biggest.lineItems.map(line => line.id), ['removal-base', 'removal-junk-full', 'removal-junk-partial', 'removal-special', 'removal-access', 'service-egc-006', 'service-egc-007', 'service-egc-011', 'service-egc-012', 'shelving-goods', 'storage-goods', 'labor']);
  assert.equal(biggest.lineItems.length, MAX_CHARGED_LINES, 'the largest quote, labor included, still fits the portal');
  assert.equal(biggest.breakdown.lines.filter(line => line.section === 'storage').length, 16, 'every storage pick stays itemized');
  assert.ok(biggest.breakdown.lines.filter(line => line.section === 'storage').every(line => line.lineItemId === 'storage-goods'));
  const storageLine = biggest.lineItems.find(line => line.id === 'storage-goods');
  assert.equal(storageLine.totalCents, biggest.breakdown.sections[2].subtotalCents);
  assert.ok(storageLine.description.length <= 600 && storageLine.description.startsWith(`${menu.products.find(item => item.id === storage[0].id).name} × 1 pack`));
});

test('the breakdown carries category, sku, qty, unit, unitsPerPack and the purchase / grab list, never a cost', () => {
  const pack = menu.products.find(item => item.unitsPerPack > 1);
  const priced = priceCompositeQuote(state(), descriptor({ removal: [pick(TRUCK), pick(STAIRS)], shelving: [pick(shelf, 6)], storage: [pick(pack, 3)] }), { complete: true });
  const lines = priced.breakdown.lines;
  assert.deepEqual(lines.map(line => [line.section, line.category, line.lineItemId]), [['removal', 'removal', 'removal-junk-full'], ['removal', 'removal', 'removal-access'], ['shelving', 'shelving', 'shelving-goods'], ['storage', 'storage', 'storage-goods']]);
  const goods = lines.find(line => line.id === pack.id);
  assert.deepEqual([goods.sku, goods.qty, goods.unit, goods.unitsPerPack, goods.productUrl, goods.retailer], [pack.sku, 3, 'pack', pack.unitsPerPack, pack.productUrl, 'The Home Depot']);
  assert.deepEqual([lines[0].menuId, lines[0].unit, lines[0].sku, lines[0].unitsPerPack], ['EGC-026', 'load', null, null]);
  assert.deepEqual(priced.breakdown.purchaseList.map(row => [row.sku, row.packs, row.units, row.perOrderPackLimit, row.overOrderLimit]), [[shelf.sku, 6, 6, 5, true], [pack.sku, 3, 3 * pack.unitsPerPack, null, false]], 'six packs is over the 5-pack order limit');
  assert.equal(priced.breakdown.totalCents, priced.totalCents);
  costFree(priced.breakdown);
  // Any other saved quote derives a breakdown from its lines: walkthrough lines by id, catalog lines by category.
  const legacy = quoteBreakdown({ estimate: { lineItems: [
    { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 90000, totalCents: 90000 },
    { id: 'special-mattress', kind: 'fee', name: 'Special handling: Mattress', quantity: 1, unitCents: 7000, totalCents: 7000 },
    { id: 'shelving', kind: 'product', name: 'Metal shelving unit', quantity: 2, unitCents: 75000, totalCents: 150000 },
    { id: 'totes', kind: 'product', name: 'Storage tote', quantity: 4, unitCents: 3250, totalCents: 13000 },
    { id: 'deep-clean', kind: 'service', name: 'Deep clean', quantity: 1, unitCents: 33000, totalCents: 33000 },
  ] } });
  assert.deepEqual(legacy.lines.map(line => [line.id, line.section, line.category]), [['cleanout', 'removal', 'removal'], ['special-mattress', 'removal', 'removal'], ['shelving', 'shelving', 'shelving'], ['totes', 'storage', 'storage'], ['deep-clean', 'removal', 'service']]);
  assert.equal(legacy.source, 'line_items');
  assert.equal(quoteBreakdown({ quoteDraft: { breakdown: priced.breakdown } }), priced.breakdown, 'a builder quote returns its saved breakdown');
  assert.equal(quoteBreakdown({}), null);
  assert.equal(sectionOfCatalogCategory('shelving'), 'shelving');
  assert.equal(sectionOfCatalogCategory('overhead'), 'storage');
});

test('pricing privacy: only owners and managers see the goods cost basis; sales get sell prices and reasons', () => {
  const sales = builderMenu(state(), { internal: false, canApprove: false });
  costFree(sales);
  assert.equal(sales.internal, undefined);
  assert.deepEqual(sales.viewer, { internal: false, canApprove: false });
  assert.ok(sales.products.every(item => Number.isSafeInteger(item.unitCents) && typeof item.reason === 'string'));
  assert.equal(sales.services.find(item => item.id === TRUCK.id).approved, true);
  // No sales-visible product text states a dollar amount (a retail price is the cost basis); only the reason
  // carries the selling price.
  for (const item of sales.products) assert.doesNotMatch(JSON.stringify({ ...item, reason: '' }), /\$\s?\d/, item.id);
  for (const item of menu.products) assert.doesNotMatch(item.fitWarnings || '', /\$\s?\d/, item.id);
  const goods = priceCompositeQuote(state(), descriptor({ removal: [pick(TRUCK)], storage: menu.products.filter(item => item.section === 'storage').slice(0, 40).map(item => pick(item)) }), { complete: true });
  assert.doesNotMatch(JSON.stringify(goods.breakdown), /\$\s?\d/, 'the breakdown and purchase list state no price as text');
  const owner = builderMenu(state(), { internal: true, canApprove: true });
  assert.equal(owner.products.find(item => item.id === shelf.id).retailPerPackCents, 8900);
  assert.deepEqual(owner.viewer, { internal: true, canApprove: true });
  assert.equal(builderMenu(state(), { internal: false, canApprove: true }).viewer.canApprove, false, 'approval needs an internal (owner) viewer');
  assert.deepEqual(owner.steps, ['removal', 'shelving', 'storage']);
});

// ---- Owner bulk approval: /api/catalog menu.approve, reusing the catalog receipts and audit trail ----
const NOW = '2026-10-17T18:00:00.000Z', ORIGIN = 'https://easygaragecleaning.com', ROOT = 'projects/egcw-1ec83/databases/(default)/documents/';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const BUILDER = { EGC_QUOTE_BUILDER_ENABLED: 'true' };
function firestore() {
  const docs = new Map(), commits = [];
  let tick = 0;
  const time = () => `2026-10-17T18:00:00.${String(++tick).padStart(6, '0')}Z`;
  const error = (status, code, message) => Response.json({ error: { code, status, ...(message ? { message } : {}) } }, { status: code });
  async function fetcher(_env, url, options = {}) {
    const path = decodeURIComponent(new URL(url).pathname.split('/documents')[1] || '');
    if (options.method === 'POST' && path === ':commit') {
      const { writes } = JSON.parse(options.body), keys = writes.map(write => write.update.name.slice(ROOT.length));
      commits.push(keys);
      for (const [index, write] of writes.entries()) {
        const current = docs.get(keys[index]);
        if (write.currentDocument?.exists === false && current) return error('ALREADY_EXISTS', 409);
        if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return error('FAILED_PRECONDITION', 400);
      }
      const at = time();
      for (const [index, write] of writes.entries()) {
        const fields = { ...(docs.get(keys[index])?.fields || {}) };
        for (const field of write.updateMask.fieldPaths) fields[field] = write.update.fields[field];
        docs.set(keys[index], { fields, updateTime: at });
      }
      return Response.json({ writeResults: writes.map(() => ({ updateTime: at })) });
    }
    const key = path.slice(1), doc = docs.get(key);
    return doc ? Response.json({ name: ROOT + key, fields: doc.fields, updateTime: doc.updateTime }) : error('NOT_FOUND', 404, `Document "${ROOT}${key}" not found.`);
  }
  return { docs, commits, fetcher, get: key => docs.has(key) ? decodeFirestoreFields(docs.get(key).fields) : null, put: (key, data) => docs.set(key, { fields: encodeFirestoreFields(data), updateTime: time() }) };
}
const handlers = (who, fs) => catalogHandlers({ session: async () => who, storage: env => catalogStorage(env, fs.fetcher), now: () => new Date(NOW) });
const post = (h, body, env) => h.post({ request: new Request(`${ORIGIN}/api/catalog`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
const approval = (extra = {}) => ({ action: 'menu.approve', requestId: randomUUID(), expectedRevision: null, menuVersion: menu.menuVersion, settingsVersion: defaults.settingsVersion, approve: [{ id: MATTRESS.id, unitCents: 7500 }, { id: shelf.id, unitCents: 11570 }], ...extra });

test('menu.approve: the owner bulk-approves draft prices with a receipt and an owner-only audit entry, idempotently', async () => {
  const fs = firestore(), h = handlers(owner, fs), body = approval();
  const response = await post(h, body, BUILDER), data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual([data.action, data.replayed, data.approvals.count, data.approvals.current], ['menu.approve', false, 2, true]);
  const saved = fs.get(`${MENU_APPROVALS}/current`);
  assert.deepEqual([saved.approvals[MATTRESS.id].unitCents, saved.approvals[MATTRESS.id].kind, saved.approvals[shelf.id].unitCents, saved.approvals[shelf.id].basis], [7500, 'service', 11570, { retailPerPackCents: 8900, goodsMarkup: 1.3 }]);
  assert.equal(saved.approvals[MATTRESS.id].basis.draftCents, 7000);
  assert.deepEqual([saved.approvals[MATTRESS.id].identity, saved.approvals[shelf.id].identity], [menuItemIdentity(MATTRESS), menuItemIdentity(shelf)], 'each approval names the item it was given for');
  assert.deepEqual(fs.commits[0].map(key => key.split('/')[0]).sort(), ['catalogOperations', 'hub_audit', MENU_APPROVALS].sort(), 'approvals, receipt and audit commit together');
  const audit = fs.get(fs.commits[0].find(key => key.startsWith('hub_audit/')));
  assert.deepEqual([audit.action, audit.visibility, audit.actor.id, audit.truncated], ['pricing_menu.approve', 'owner', 'zacb', false]);
  assert.match(audit.after, /7500/);
  const receipt = fs.get(fs.commits[0].find(key => key.startsWith('catalogOperations/')));
  assert.deepEqual(receipt.result.changes, [{ id: MATTRESS.id, unitCents: 7500, previous: null }, { id: shelf.id, unitCents: 11570, previous: null }], 'the receipt keeps every amount and the amount it replaced');
  // The same request replays; the state now prices from the approvals.
  const replay = await (await post(h, body, BUILDER)).json();
  assert.equal(replay.replayed, true);
  assert.equal(fs.commits.length, 1);
  const composite = await readCompositeState(catalogStorage({}, fs.fetcher));
  const priced = priceCompositeQuote(composite, descriptor({ removal: [pick(MATTRESS)], shelving: [pick(shelf)] }), { complete: true });
  assert.deepEqual([priced.approval.blocked.map(row => row.id), priced.lineItems[0].totalCents], [[], 7500], 'both prices are approved and the labor rate is the owner\'s: the quote can be sent');
  // Revoking needs the revision now in force; a stale one is a conflict.
  const stale = await post(h, approval({ approve: [], revoke: [MATTRESS.id] }), BUILDER);
  assert.deepEqual([stale.status, (await stale.json()).code], [409, 'catalog_revision_conflict']);
  const revoked = await (await post(h, approval({ approve: [], revoke: [MATTRESS.id], expectedRevision: data.approvals.revision }), BUILDER)).json();
  assert.equal(revoked.approvals.count, 1);
  assert.equal(fs.get(`${MENU_APPROVALS}/current`).approvals[MATTRESS.id], undefined);
});

test('menu.approve refuses a product at any price but cost × goodsMarkup, unknown or already-approved items, and non-owners', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const code = async (body, env = BUILDER, who = h) => { const response = await post(who, body, env); return [response.status, (await response.json()).code]; };
  assert.deepEqual(await code(approval({ approve: [{ id: shelf.id, unitCents: 9999 }] })), [409, 'catalog_menu_price_changed']);
  assert.deepEqual(await code(approval({ approve: [{ id: TRUCK.id, unitCents: 80000 }] })), [400, 'catalog_menu_item_approved']);
  assert.deepEqual(await code(approval({ approve: [{ id: 'egc-999', unitCents: 100 }] })), [400, 'catalog_menu_item_unknown']);
  assert.deepEqual(await code(approval({ approve: [], revoke: [MATTRESS.id] })), [400, 'catalog_menu_item_not_approved']);
  assert.deepEqual(await code(approval({ approve: [] })), [400, 'catalog_request_invalid']);
  // At most 100 changes per request, so the owner-only audit entry (100 keys per snapshot) records every amount.
  assert.equal(MAX_MENU_CHANGES, 100);
  const many = menu.products.slice(0, 101).map(item => ({ id: item.id, unitCents: menuPrices(state()).get(item.id).unitCents }));
  assert.deepEqual(await code(approval({ approve: many })), [400, 'catalog_request_invalid']);
  assert.deepEqual(await code(approval({ menuVersion: '2026-01-01.1' })), [409, 'catalog_version_conflict']);
  assert.deepEqual(await code(approval({ settingsVersion: 'older' })), [409, 'catalog_version_conflict']);
  assert.deepEqual(await code(approval(), BUILDER, handlers(manager, fs)), [403, 'catalog_owner_required']);
  assert.equal(fs.commits.length, 0, 'nothing was written');
});

test('flag off: menu.approve behaves exactly as an unknown catalog action did before the builder existed', async () => {
  const fs = firestore(), h = handlers(owner, fs), code = async env => { const response = await post(h, approval(), env); return [response.status, (await response.json()).code]; };
  assert.deepEqual(await code({}), [404, 'catalog_disabled'], 'both flags off: every write is 404');
  assert.deepEqual(await code({ CATALOG_QUOTES_ENABLED: 'true' }), [400, 'catalog_action_invalid'], 'catalog on, builder off: unchanged');
  assert.deepEqual(await code({ EGC_QUOTE_BUILDER_ENABLED: 'TRUE' }), [404, 'catalog_disabled'], 'the flag is exactly "true"');
  // With the builder alone on, settings and publishing stay closed.
  const settings = await post(h, { action: 'settings.update', requestId: randomUUID(), expectedRevision: null, settings: { ...structuredClone(defaults), settingsVersion: 'owner-1' } }, BUILDER);
  assert.deepEqual([settings.status, (await settings.json()).code], [404, 'catalog_disabled']);
  await assert.rejects(mutateCatalog(catalogStorage({}, fs.fetcher), owner, approval(), NOW), { code: 'catalog_action_invalid' }, 'mutateCatalog needs the builder option for menu.approve');
  assert.equal(fs.commits.length, 0);
});

test('menu.approve of 100 prices records every amount in the owner-only audit entry', async () => {
  const fs = firestore(), prices = menuPrices(state());
  const hundred = menu.products.slice(0, MAX_MENU_CHANGES).map(item => ({ id: item.id, unitCents: prices.get(item.id).unitCents }));
  const response = await post(handlers(owner, fs), approval({ approve: hundred }), BUILDER);
  assert.equal(response.status, 200);
  const audit = fs.get(fs.commits[0].find(key => key.startsWith('hub_audit/')));
  assert.equal(audit.truncated, false);
  assert.equal(Object.keys(JSON.parse(audit.after)).length, MAX_MENU_CHANGES);
});

test('the Hub says the builder is on only in answers the pages already load; flag off they are unchanged', async () => {
  const { pricingConfigHandlers } = await import('../functions/api/pricing-config.js');
  const pricing = pricingConfigHandlers({ session: async () => owner });
  const config = async (env, parts = 'walkthrough') => (await pricing.get({ request: new Request(`${ORIGIN}/api/pricing-config?parts=${parts}`), env })).json();
  const off = await config({}), on = await config(BUILDER);
  assert.equal(off.ok, true);
  assert.equal(Object.hasOwn(off, 'quoteBuilder'), false);
  assert.equal(on.quoteBuilder, true);
  assert.deepEqual({ ...on, quoteBuilder: undefined }, { ...off, quoteBuilder: undefined }, 'nothing else changes');
  assert.equal(Object.hasOwn(await config({ EGC_QUOTE_BUILDER_ENABLED: 'yes' }), 'quoteBuilder'), false, 'exactly "true"');
  const ownerOnly = await config(BUILDER, 'owner');
  assert.deepEqual([ownerOnly.ok, Object.hasOwn(ownerOnly, 'quoteBuilder')], [true, false], 'only with the walkthrough tables');
  const fs = firestore(), catalog = catalogHandlers({ session: async () => owner, storage: env => catalogStorage(env, fs.fetcher), now: () => new Date(NOW), cache: new Map() });
  const overview = async (env, query = '?view=full') => (await catalog.get({ request: new Request(`${ORIGIN}/api/catalog${query}`), env })).json();
  assert.deepEqual(await overview({}), { ok: true, authority: 'employee_hub', enabled: false });
  assert.deepEqual(await overview(BUILDER), { ok: true, authority: 'employee_hub', enabled: false, quoteBuilder: true });
  const full = await overview({ CATALOG_QUOTES_ENABLED: 'true' }), both = await overview({ CATALOG_QUOTES_ENABLED: 'true', ...BUILDER });
  assert.equal(Object.hasOwn(full, 'quoteBuilder'), false);
  assert.deepEqual({ ...both, quoteBuilder: undefined }, { ...full, quoteBuilder: undefined });
  assert.equal(both.quoteBuilder, true);
  assert.equal(Object.hasOwn(await overview({ CATALOG_QUOTES_ENABLED: 'true', ...BUILDER }, '?view=status'), 'quoteBuilder'), false);
});

test('funnel metrics place builder lines by catalog category: goods steps and cleaning services, never junk or access', () => {
  assert.deepEqual([compositeCatalogCategory('menu-shelving'), compositeCatalogCategory('menu-storage')], ['shelving', 'wall-systems']);
  assert.deepEqual([compositeCatalogCategory(TWO_CAR.id), compositeCatalogCategory(DEEP_TWO.id), compositeCatalogCategory(TRUCK.id), compositeCatalogCategory(STAIRS.id)], ['services', 'services', null, null]);
  assert.deepEqual([compositeCatalogCategory('hd-100006678'), compositeCatalogCategory('egc-999'), compositeCatalogCategory(null)], [null, null, null]);
  const lines = items => priceCompositeQuote(state(), descriptor(items), { complete: true }).storedLineItems;
  assert.deepEqual(lineItemCatalogCategories(lines({ removal: [pick(TWO_CAR), pick(TRUCK)], shelving: [pick(shelf)], storage: [pick(product('storage', 'overhead'))] })), ['services', 'shelving', 'wall-systems']);
  assert.deepEqual(lineItemCatalogCategories(lines({ removal: [pick(TRUCK), pick(MATTRESS), pick(STAIRS)] })), [], 'a junk-only quote is left to the other service-line sources');
});

test('firestore.rules keeps the menu approvals server-only', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/pricingMenuApprovals\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
});
