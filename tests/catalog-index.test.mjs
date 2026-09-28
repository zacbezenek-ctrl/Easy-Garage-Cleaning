import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {INDEX,INDEX_KEYS,buildCatalogIndex,expectedCatalogIndex,readCatalog,renderCatalogIndex} from '../scripts/generate-catalog-index.mjs';

const committedText = fs.readFileSync(new URL(`../${INDEX}`, import.meta.url), 'utf8');
const committed = JSON.parse(committedText);
const shipped = readCatalog();
const fresh = () => structuredClone(shipped);
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach(entry => keysOf(entry, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => { out.add(key); keysOf(entry, out); });
  return out;
};

test('the committed conversation catalog index matches the Hub catalog (drift guard: run node scripts/generate-catalog-index.mjs --write)', () => {
  assert.equal(committedText, expectedCatalogIndex());
  assert.equal(committed.catalogVersion, shipped.catalogVersion);
});

test('the index holds ids, names, categories, brands and tiers only, never prices, costs or sources', () => {
  assert.deepEqual(Object.keys(committed), ['catalogVersion', 'items']);
  for (const item of committed.items) {
    assert.deepEqual(Object.keys(item), INDEX_KEYS);
    assert.ok(item.brands.length <= 1 && item.tiers.length <= 1);
    for (const tier of item.tiers) assert.ok(['good', 'better', 'best'].includes(tier));
  }
  assert.deepEqual([...keysOf(committed)].sort(), ['brands', 'catalogVersion', 'category', 'id', 'items', 'name', 'tiers']);
  assert.doesNotMatch(committedText, /https?:\/\//i);
  for (const item of shipped.items.filter(entry => entry.fixedPriceCents || entry.retailPriceHighCents)) {
    for (const cents of [item.fixedPriceCents, item.retailPriceLowCents, item.retailPriceHighCents].filter(Number.isInteger)) assert.ok(!committedText.includes(`"${cents}"`) && !committedText.includes(`:${cents}`), `${item.id} price leaked`);
  }
});

test('hidden items are left out; every other catalog item is indexed once with its brand and tier', () => {
  const visible = shipped.items.filter(item => item.availability !== 'hidden');
  assert.ok(shipped.items.some(item => item.availability === 'hidden'), 'fixture must include a hidden item');
  assert.deepEqual(committed.items.map(item => item.id), visible.map(item => item.id));
  assert.equal(new Set(committed.items.map(item => item.id)).size, committed.items.length);
  const service = committed.items.find(item => item.id === 'svc-labeled-tote');
  assert.deepEqual(service, {id: 'svc-labeled-tote', name: 'Labeled 27-gallon tote, grouped by zone', category: 'services', brands: [], tiers: []});
  const hook = committed.items.find(item => item.id === 'bike-hook-everbilt-screw-in-25lb');
  assert.deepEqual(hook, {id: 'bike-hook-everbilt-screw-in-25lb', name: 'Everbilt Vinyl Coated Steel Screw-In Bicycle Hook, 25 lb', category: 'bikes', brands: ['Everbilt'], tiers: ['good']});
});

test('price edits do not change the index; name, availability and version edits do', () => {
  const baseline = renderCatalogIndex(buildCatalogIndex(fresh()));
  const repriced = fresh();
  const product = repriced.items.find(item => item.kind === 'product' && item.availability === 'active');
  product.retailPriceLowCents += 100; product.retailPriceHighCents += 100;
  assert.equal(renderCatalogIndex(buildCatalogIndex(repriced)), baseline);
  const renamed = fresh();
  renamed.items[0].name = 'Synthetic renamed hook';
  assert.notEqual(renderCatalogIndex(buildCatalogIndex(renamed)), baseline);
  const hidden = fresh();
  hidden.items[0].availability = 'hidden';
  assert.equal(buildCatalogIndex(hidden).items.some(item => item.id === shipped.items[0].id), false);
  const bumped = fresh();
  bumped.catalogVersion = '2026-09-27.2';
  assert.match(renderCatalogIndex(buildCatalogIndex(bumped)), /"catalogVersion": "2026-09-27.2"/);
});

test('an invalid catalog is refused instead of indexed; a missing catalog gives an empty index', () => {
  const broken = fresh();
  broken.items[0].tier = 'premium';
  assert.throws(() => buildCatalogIndex(broken), error => error.code === 'catalog_invalid');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-catalog-index-'));
  try {
    assert.equal(readCatalog(root), null);
    assert.equal(expectedCatalogIndex(root), '{\n  "catalogVersion": null,\n  "items": []\n}\n');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
