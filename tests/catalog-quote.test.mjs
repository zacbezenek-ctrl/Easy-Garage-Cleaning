import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceCatalogQuote } from '../functions/_lib/catalog-quote.js';

const source = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = source('../functions/_data/garage-catalog.json');
const defaults = source('../functions/_data/pricing-settings.defaults.json');
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
