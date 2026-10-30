import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORY_GROUPS, ITEM_BASIS, buildPricingMenu, checkCommitted, importProducts, importServices, parseCsv, renderMenuJson, renderMenuModule, scrubNote, scrubWarnings } from '../scripts/import-pricing-menu.mjs';
import { BUILDER_SECTIONS, validatePricingMenu } from '../functions/_lib/composite-quote.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';

// Five public product rows and six item rows copied from the owner's workbook export, with every cost, margin,
// proposed price and commission column replaced by FORBIDDEN-* markers: none may ever reach the output.
const fixture = name => readFileSync(new URL(`./fixtures/pricing-menu/${name}`, import.meta.url), 'utf8');
const productsCsv = fixture('Visual_products.csv'), itemsCsv = fixture('Item_menu.csv');

test('the CSV reader handles quoted fields, doubled quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi"""\r\n1,,"two\nlines"\n'), [['a', 'b,c', 'say "hi"'], ['1', '', 'two\nlines']]);
  assert.deepEqual(parseCsv('﻿x,y'), [['x', 'y']]);
  assert.throws(() => parseCsv('a,"open'), /quoted field/);
});

test('products import as DRAFT entries with SKU, units per pack, retail per pack, step, URLs, pack limit, fit warnings and evidence date', () => {
  const { products } = importProducts(productsCsv);
  assert.equal(products.length, 5, 'the SKU-less note row is skipped');
  const shelf = products[0];
  assert.deepEqual(shelf, {
    id: 'hd-100006678', sku: '100006678', retailer: 'The Home Depot', name: 'HDX plastic shelving, 36×72×24', section: 'shelving', group: 'shelving',
    unitsPerPack: 1, retailPerPackCents: 8900, perOrderPackLimit: 5,
    productUrl: 'https://www.homedepot.com/p/HDX-5-Tier-Easy-Assembly-Multi-purpose-Plastic-Garage-Storage-Shelving-Unit-in-Gray-36-in-W-x-72-in-H-x-24-in-D-128974/100006678',
    photoUrl: 'https://images.thdstatic.com/productImages/d511e4c2-ac85-4b6c-9461-4a7a2606df52/svn/gray-hdx-freestanding-shelving-units-128974-64_1000.jpg',
    fitWarnings: '27-gal tote is 15.2 in tall, exceeding fixed shelf spacing. Do not represent as fitting these totes between shelves. 36 W × 72 H × 24 D in; 14.86 in fixed shelf spacing Limit 5 per order.',
    evidence: { checkedOn: '2026-10-16', sourceUrl: shelf.productUrl, note: 'Official retail page/category, checked 2026-10-16; not invoice' }, status: 'draft' });
  assert.deepEqual(products.map(item => [item.section, item.group]), [['shelving', 'shelving'], ['storage', 'hooks-racks'], ['storage', 'track-systems'], ['storage', 'bike-storage'], ['storage', 'bins-totes']]);
  const pack = products.find(item => item.unitsPerPack > 1);
  assert.equal(pack.unitsPerPack, 2);
  assert.ok(products.every(item => item.status === 'draft' && (item.perOrderPackLimit === null || item.perOrderPackLimit === 5)));
  // Every workbook category maps to a group of the shelving or extra storage step.
  const groups = new Map(BUILDER_SECTIONS.flatMap(section => section.groups.map(group => [group.id, section.id])));
  for (const [section, group] of Object.values(CATEGORY_GROUPS)) assert.equal(groups.get(group), section);
});

test('only the builder\'s service rows import; the approved full truck keeps its amount and nothing else carries a price', () => {
  const { services, skipped } = importServices(itemsCsv);
  assert.deepEqual(skipped, ['EGC-001'], 'labor is a planning benchmark, not a quote line');
  assert.deepEqual(services.map(item => [item.menuId, item.group, item.category, item.unit, item.status, item.approvedPriceCents ?? null]), [
    ['EGC-003', 'cleaning-base', 'service', 'job', 'draft', null], ['EGC-024', 'junk', 'removal', 'load', 'draft', null], ['EGC-026', 'junk', 'removal', 'load', 'approved', 75000],
    ['EGC-027', 'special', 'removal', 'item', 'draft', null], ['EGC-047', 'access', 'removal', 'job', 'draft', null]]);
  assert.deepEqual(services.find(item => item.menuId === 'EGC-024').basis, { kind: 'junk', fraction: 0.5 });
  assert.deepEqual(services.find(item => item.menuId === 'EGC-003').basis, { kind: 'walkthrough', table: 'sizeBase', key: '2' });
  assert.equal(services.find(item => item.menuId === 'EGC-026').scopeNote, 'Owner approved full-truck amount only. Verify weight.', 'a sentence about commission or margin is dropped');
  // Every mapped item resolves against the walkthrough price tables the server prices drafts from.
  const tables = walkthroughPricing(walkthroughServiceItems());
  for (const [id, [, , basis]] of Object.entries(ITEM_BASIS)) {
    if (basis.kind === 'junk') continue;
    const value = basis.table === 'sizeBase' ? tables.sizeBase[basis.key] : basis.table === 'services' ? tables.services[basis.key]?.amount : basis.table === 'deep_clean' ? tables.services.deep_clean.bySize[basis.key]?.amount : basis.table === 'hazards' ? tables.hazards[basis.key]?.amount : tables[basis.table][basis.key];
    assert.ok(typeof value === 'number' && value > 0, `${id} ${basis.table} ${basis.key}`);
  }
});

test('the imported menu validates and never contains a margin, proposed price, commission or private reference', () => {
  const { menu, report } = buildPricingMenu({ productsCsv, itemsCsv }, { evidenceDate: '2026-10-16' });
  assert.doesNotThrow(() => validatePricingMenu(menu));
  assert.deepEqual([menu.menuVersion, menu.generatedOn, menu.status, report.products, report.services, report.approved], ['2026-10-16.1', '2026-10-16', 'draft', 5, 5, ['EGC-026']]);
  const text = renderMenuJson(menu);
  assert.doesNotMatch(text, /FORBIDDEN|commission|margin|mail\.google|@/i);
  assert.equal(JSON.parse(text).products.length, 5);
  assert.match(renderMenuModule(text), /^\/\/ Generated from functions\/_data\/pricing-menu\.json/);
  assert.equal(JSON.parse(JSON.parse(renderMenuModule(text).match(/PRICING_MENU_JSON = (".*");/)[1])).menuVersion, '2026-10-16.1');
});

test('a re-import keeps the owner\'s approvals in code (2026-10-30) for the items still on the menu', () => {
  const approvals = { approvedBy: 'owner', approvedOn: '2026-10-30', note: 'Approved in code by the owner.', items: {
    'hd-100006678': { unitCents: 11570, identity: 'product|100006678|1|shelving' }, 'egc-003': { unitCents: 97500, identity: 'service|EGC-003|Two-car garage base|job|cleaning-base|sizeBase:2|2' },
    'egc-026': { unitCents: 100000, identity: 'x' }, 'egc-099': { unitCents: 100, identity: 'gone' } } };
  const { menu } = buildPricingMenu({ productsCsv, itemsCsv }, { evidenceDate: '2026-10-16', approvals });
  assert.deepEqual(Object.keys(menu.approvals.items), ['hd-100006678', 'egc-003'], 'an item no longer imported, or one the menu now approves at a fixed amount, is dropped');
  assert.deepEqual([menu.approvals.approvedOn, menu.approvals.items['egc-003'].unitCents], ['2026-10-30', 97500]);
  assert.doesNotThrow(() => validatePricingMenu(menu));
  assert.equal('approvals' in buildPricingMenu({ productsCsv, itemsCsv }).menu, false, 'none without a committed menu');
});

test('a row the importer cannot place, or one claiming approval, stops the import instead of guessing', () => {
  const header = productsCsv.split('\n')[2];
  const row = productsCsv.split('\n')[3];
  assert.throws(() => importProducts([header, row.replace('DRAFT PRODUCT; pricing and installation scope not approved', 'APPROVED')].join('\n')), /no approval is inferred/);
  assert.throws(() => importProducts([header, row.replace(',Shelving,', ',Garden,')].join('\n')), /has no builder step/);
  assert.throws(() => importProducts([header, row.replace(',89.0,', ',eighty,')].join('\n')), /not a dollar amount/);
  assert.throws(() => importProducts('no,header\n1,2'), /no header row/);
  const items = itemsCsv.split('\n');
  assert.throws(() => importServices([items[2], items.find(line => line.startsWith('EGC-027')).replace(',Pending,', ',Maybe,')].join('\n')), /neither Approved nor Pending/);
});

test('scope notes keep handling guidance and drop money, margin and commission sentences', () => {
  assert.equal(scrubNote('Verify facility fee and handling.'), 'Verify facility fee and handling.');
  assert.equal(scrubNote('Illustrative fraction of $750, not an approved rate. Minimum policy pending.'), 'Minimum policy pending.');
  assert.equal(scrubNote('Synthetic 99% margin note only.'), null);
  assert.equal(scrubNote('Synthetic goods at cost x9.99 only.'), null);
});

test('fit warnings keep sizes and fit guidance but drop every sentence that states a dollar amount (the cost basis)', () => {
  assert.equal(scrubWarnings('Four of single tote 327528802. $39.92/bundle = $9.98/tote. No quantity discount.'), 'Four of single tote 327528802. No quantity discount.');
  assert.equal(scrubWarnings('Retail discrepancy: earlier page $ 9.98; latest category 8.98 dollars used. Verify local price. 28.6 L × 19.6 W × 15.2 H in, 75 lb.'), 'Verify local price. 28.6 L × 19.6 W × 15.2 H in, 75 lb.');
  assert.equal(scrubWarnings('Only $5.'), null);
  assert.equal(scrubWarnings(''), null);
  // A fixture row whose warning names its pack price imports without it.
  const header = productsCsv.split('\n')[2], row = productsCsv.split('\n')[3];
  const [shelf] = importProducts([header, row.replace('Limit 5 per order.', 'Limit 5 per order. Pack is $89.00 at checkout.')].join('\n')).products;
  assert.match(shelf.fitWarnings, /Limit 5 per order\.$/);
  assert.doesNotMatch(shelf.fitWarnings, /\$/);
});

test('the committed menu and its module agree (node scripts/import-pricing-menu.mjs --check)', () => {
  assert.deepEqual(checkCommitted(), { ok: true });
});
