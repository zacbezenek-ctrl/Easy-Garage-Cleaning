import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceCatalogQuote } from '../functions/_lib/catalog-quote.js';
import { quoteBreakdown, sectionOfCatalogCategory } from '../functions/_lib/composite-quote.js';

const source = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = source('../functions/_data/garage-catalog.json');
// Pinned to the 20% worked-example markup, independent of the owner's live markup.
const shipped = source('../functions/_data/pricing-settings.defaults.json');
const defaults = { ...shipped, markupPct: { default: 20, byCategory: Object.fromEntries(Object.keys(shipped.markupPct.byCategory).map(id => [id, 20])) } };
const state = (settings = {}) => ({ catalog, publication: { version: catalog.catalogVersion },
  settings: { ...structuredClone(defaults), mustSetBeforeCustomerUse: false, ...settings } });
const rack = catalog.items.find(item => item.id === 'overhead-rack-fleximounts-gr48-classic-4x8');
const selection = (item = rack, extra = {}) => ({ catalogVersion: catalog.catalogVersion, settingsVersion: defaults.settingsVersion,
  items: [{ id: 'catalog-1', itemId: item.id, quantity: 1, customerSupplied: false, ...extra }] });
const day = new Date('2026-09-30T18:00:00.000Z');

test('released catalog quote prices exact cents, charges the minimum once and hides the internal cost split in preview', () => {
  const priced = priceCatalogQuote(state({ depositPct: 30 }), selection(), day);
  assert.deepEqual([priced.subtotalCents, priced.minimumAdjustmentCents, priced.totalCents, priced.depositCents, priced.depositPct], [39399, 5601, 45000, 13500, 30]);
  assert.deepEqual(priced.lineItems.map(line => [line.id, line.totalCents]), [['catalog-1', 39399], ['catalog-minimum', 5601]]);
  assert.equal(priced.lineItems[0].split, undefined);
  assert.deepEqual(priced.storedLineItems[0].split, { productCents: 19499, laborCents: 15000, markupCents: 3900, disposalCents: 1000, laborMinutes: 120 });
  assert.deepEqual(priced.storedLineItems[0].catalog, { itemId: rack.id, version: catalog.catalogVersion });
  assert.equal(priced.storedLineItems[1].kind, 'fee');
  const supplied = priceCatalogQuote(state(), selection(rack, { quantity: 2, customerSupplied: true }), day);
  assert.deepEqual([supplied.subtotalCents, supplied.minimumAdjustmentCents, supplied.totalCents], [32000, 13000, 45000]);
  assert.equal(supplied.storedLineItems[0].split.productCents, 0);
  assert.equal(supplied.storedLineItems[0].split.markupCents, 0);
  const mixed = priceCatalogQuote(state({ minimumJobCents: 0 }), { ...selection(), items: [
    { id: 'catalog-2', itemId: rack.id, quantity: 1, customerSupplied: false },
    { id: 'catalog-4', itemId: rack.id, quantity: 2, customerSupplied: true },
  ] }, day);
  assert.deepEqual(mixed.lineItems.map(line => [line.id, line.totalCents, line.customerSupplied]),
    [['catalog-2', 39399, false], ['catalog-4', 32000, true]], 'removed IDs stay removed and both supply choices can be quoted');
});

test('catalog preview refuses placeholders, old versions and unverified or stale products before any customer quote exists', () => {
  assert.throws(() => priceCatalogQuote(state({ mustSetBeforeCustomerUse: true }), selection(), day), { code: 'quote_draft_catalog_not_released' });
  assert.throws(() => priceCatalogQuote(state(), { ...selection(), settingsVersion: 'older' }, day), { code: 'quote_draft_catalog_version_changed' });
  assert.throws(() => priceCatalogQuote(state(), { ...selection(), catalogVersion: 'older' }, day), { code: 'quote_draft_catalog_version_changed' });
  const unverified = catalog.items.find(item => item.kind === 'product' && item.availability === 'active' && !item.priceVerified);
  assert.ok(unverified);
  assert.throws(() => priceCatalogQuote(state(), selection(unverified), day), { code: 'quote_draft_catalog_price_unverified' });
  assert.throws(() => priceCatalogQuote(state(), selection(), new Date('2027-01-15T18:00:00.000Z')), { code: 'quote_draft_catalog_price_unverified' });
  assert.throws(() => priceCatalogQuote(state(), selection(rack, { quantity: 1.5 }), day), { code: 'quote_draft_catalog_invalid_selection' });
  assert.throws(() => priceCatalogQuote(state(), selection(rack, { quantity: 10000 }), day), { code: 'quote_draft_catalog_invalid_selection' });
  assert.throws(() => priceCatalogQuote(state(), { ...selection(), items: [selection().items[0], { ...selection().items[0], id: 'catalog-2' }] }, day), { code: 'quote_draft_catalog_invalid_selection' });
  assert.throws(() => priceCatalogQuote(state(), { ...selection(), items: [selection().items[0], { ...selection().items[0], customerSupplied: true }] }, day), { code: 'quote_draft_catalog_invalid_selection' });
});

test('a saved Hub catalog quote exposes the same section breakdown as the builder: shelving, then extra storage, no cost', () => {
  const shelf = catalog.items.find(item => item.kind === 'product' && item.category === 'shelving' && item.availability === 'active' && item.priceVerified);
  const priced = priceCatalogQuote(state(), { ...selection(), items: [
    { id: 'catalog-1', itemId: rack.id, quantity: 1, customerSupplied: false }, { id: 'catalog-2', itemId: shelf.id, quantity: 2, customerSupplied: false }] }, day);
  const breakdown = quoteBreakdown({ estimate: { lineItems: priced.storedLineItems } }, { catalog });
  const minimum = priced.minimumAdjustmentCents ? ['catalog-minimum'] : [];
  assert.deepEqual(breakdown.sections.map(section => [section.id, section.lineIds]), [['removal', []], ['shelving', ['catalog-2', ...minimum]], ['storage', ['catalog-1']]]);
  assert.deepEqual(breakdown.lines.map(line => [line.id, line.section, line.category]), [['catalog-1', 'storage', 'storage'], ['catalog-2', 'shelving', 'shelving'], ...minimum.map(id => [id, 'shelving', 'service'])]);
  assert.equal(breakdown.totalCents, priced.totalCents);
  assert.equal(sectionOfCatalogCategory(rack.category), 'storage');
  assert.doesNotMatch(JSON.stringify(breakdown), /"split"|productCents|markupCents/);
  // With the catalog, products carry their product page and a purchase / grab row; a Home Depot page gives the SKU.
  assert.deepEqual(breakdown.purchaseList.map(row => [row.name, row.packs, row.productUrl, row.sku]), [[breakdown.lines[0].name, 1, rack.sources[0].url, null], [breakdown.lines[1].name, 2, shelf.sources[0].url, breakdown.lines[1].sku]]);
  const hook = catalog.items.find(item => item.id === 'bike-hook-everbilt-screw-in-25lb');
  const hooks = priceCatalogQuote(state(), { ...selection(), items: [{ id: 'catalog-1', itemId: hook.id, quantity: 4, customerSupplied: false }, { id: 'catalog-2', itemId: rack.id, quantity: 1, customerSupplied: true }] }, day);
  const grab = quoteBreakdown({ estimate: { lineItems: hooks.storedLineItems } }, { catalog });
  assert.deepEqual(grab.purchaseList.map(row => [row.sku, row.retailer, row.packs, row.unitsPerPack, row.units, row.productUrl]), [['206585761', 'The Home Depot', 4, 1, 4, hook.sources[0].url]], 'a customer-supplied product is not bought');
  assert.deepEqual([grab.lines[0].sku, grab.lines[0].productUrl], ['206585761', hook.sources[0].url]);
  assert.deepEqual(quoteBreakdown({ estimate: { lineItems: hooks.storedLineItems } }).purchaseList, [], 'without the catalog nothing is resolved');
});
