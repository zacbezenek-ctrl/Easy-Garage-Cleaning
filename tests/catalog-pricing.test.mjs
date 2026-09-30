import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { applyMinimum, catalogLine, catalogLinePricer, computeSellPriceCents, validatePricingSettings } from '../functions/_lib/catalog.js';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';

const readJson = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = readJson('../functions/_data/garage-catalog.json');
const defaults = readJson('../functions/_data/pricing-settings.defaults.json');
const item = id => catalog.items.find(entry => entry.id === id) || assert.fail(`missing ${id}`);
const settings = (patch = {}) => ({ ...structuredClone(defaults), ...patch });
const LINE_KEYS = ['productCents', 'laborCents', 'laborMinutes', 'markupCents', 'disposalCents', 'fixedCents', 'totalCents', 'unitCents', 'quantity', 'priceVerified', 'priceEvidence'];
// The LI-CORE line-item model (functions/_lib/quote-model.js): its line fields, its per-unit split keys and limits.
const LI_CORE_FIELDS = ['id', 'kind', 'name', 'description', 'quantity', 'unitCents', 'totalCents', 'amount', 'optional', 'selected', 'group', 'tier', 'package', 'catalog', 'customerSupplied', 'split', 'durationMinutes', 'taxable'];
const LI_CORE_SPLIT = ['productCents', 'laborCents', 'laborMinutes', 'markupCents', 'disposalCents'];
const LI_CORE_ID = /^[A-Za-z0-9_-]{1,80}$/, LI_CORE_MAX_LINE_CENTS = 100000000, LI_CORE_MAX_UNIT_MINUTES = 1440;
const SPLIT_KEYS = ['productCents', 'laborCents', 'laborMinutes', 'markupCents', 'disposalCents', 'fixedCents', 'totalCents'];
const lineFigures = price => Object.fromEntries(SPLIT_KEYS.map(key => [key, price[key]]));
const rack = item('overhead-rack-fleximounts-gr48-classic-4x8');

test('placeholder settings price a 4x8 rack exactly (the GARAGE-CATALOG.md worked example)', () => {
  assert.deepEqual([rack.retailPriceHighCents, rack.installMinutes, rack.haulAwayApplicable, rack.category], [19499, 120, true, 'overhead']);
  const price = computeSellPriceCents(rack, defaults);
  assert.deepEqual(Object.keys(price), LINE_KEYS);
  // product $194.99 + labor 120 min x $75/h = $150.00 + markup 20% of $194.99 = $38.998 -> $39.00 + disposal $10.00
  assert.deepEqual(price, { productCents: 19499, laborCents: 15000, laborMinutes: 120, markupCents: 3900, disposalCents: 1000, fixedCents: 0, totalCents: 39399, unitCents: 39399, quantity: 1, priceVerified: true, priceEvidence: 'search_snippet' });
  assert.deepEqual(catalogLine(rack, defaults), { kind: 'product', name: rack.name, quantity: 1, unitCents: 39399, totalCents: 39399, customerSupplied: false, split: { productCents: 19499, laborCents: 15000, laborMinutes: 120, markupCents: 3900, disposalCents: 1000 }, durationMinutes: 120 });
});

test('batch catalog pricing matches strict per-line pricing and keeps its validated settings snapshot', () => {
  const custom = settings({ markupPct: { default: 12.5, byCategory: { overhead: 35 } } });
  const priceLine = catalogLinePricer(custom);
  for (const entry of catalog.items.filter(candidate => candidate.availability === 'active')) {
    assert.deepEqual(priceLine(entry, { quantity: 2 }), catalogLine(entry, custom, { quantity: 2 }), entry.id);
  }
  const before = priceLine(rack);
  custom.laborRateCents = 1;
  custom.markupPct.byCategory.overhead = 0;
  assert.deepEqual(priceLine(rack), before, 'a later settings edit cannot reprice a validated batch');
  assert.throws(() => catalogLinePricer(settings({ roundingRule: 'nearest' })), { code: 'catalog_settings_invalid' });
  assert.throws(() => catalogLine(rack, settings({ roundingRule: 'nearest' })), { code: 'catalog_settings_invalid' }, 'public single-line pricing remains strict');
});

test('released catalog deposit percentage uses the same two-decimal precision as quote deposits', () => {
  assert.equal(validatePricingSettings(settings({ depositPct: 33.33 })).depositPct, 33.33);
  assert.throws(() => validatePricingSettings(settings({ depositPct: 33.333 })), { code: 'catalog_settings_invalid' });
});

test('quantity multiplies the rounded unit figures, so a line is exactly unitCents x quantity', () => {
  assert.deepEqual(computeSellPriceCents(rack, defaults, { quantity: 3 }), { productCents: 58497, laborCents: 45000, laborMinutes: 360, markupCents: 11700, disposalCents: 3000, fixedCents: 0, totalCents: 118197, unitCents: 39399, quantity: 3, priceVerified: true, priceEvidence: 'search_snippet' });
  // Markup is rounded per unit (3 x 3900). Rounding the 58497 line instead would give 11699 and a
  // 118196 total that no whole-cent unit price times 3 can reach.
  const line = catalogLine(rack, defaults, { quantity: 3 });
  assert.deepEqual([line.quantity, line.unitCents, line.totalCents, line.split.markupCents, line.durationMinutes], [3, 39399, 118197, 3900, 120], 'split and durationMinutes stay per unit');
});

test('customer-supplied products cost nothing and carry no markup, but labor and disposal remain', () => {
  const price = computeSellPriceCents(rack, defaults, { customerSupplied: true, quantity: 2 });
  assert.deepEqual(lineFigures(price), { productCents: 0, laborCents: 30000, laborMinutes: 240, markupCents: 0, disposalCents: 2000, fixedCents: 0, totalCents: 32000 });
  assert.equal(price.unitCents, 16000);
  assert.equal(computeSellPriceCents(rack, defaults, { customerSupplied: true, productCostCents: 5000 }).productCents, 0, 'customer-supplied wins over a cost override');
  const line = catalogLine(rack, defaults, { customerSupplied: true, quantity: 2 });
  assert.deepEqual([line.customerSupplied, line.split.productCents, line.split.markupCents, line.totalCents], [true, 0, 0, 32000], 'a LI-CORE customer-supplied line may not charge for the product');
});

test('an entered product cost overrides the conservative retail high price', () => {
  const price = computeSellPriceCents(rack, defaults, { productCostCents: 14599 });
  assert.deepEqual([price.productCents, price.markupCents, price.totalCents], [14599, 2920, 14599 + 15000 + 2920 + 1000]);
  assert.equal(computeSellPriceCents(rack, defaults, { productCostCents: 0 }).productCents, 0);
});

test('markup uses the category rate, falling back to the default', () => {
  const custom = settings({ markupPct: { default: 10, byCategory: { overhead: 35 } } });
  assert.equal(computeSellPriceCents(rack, custom).markupCents, 6825, '35% of 19499 = 6824.65');
  const shelf = item('shelving-husky-n3r482478w5b-48x24x78-5tier');
  assert.equal(computeSellPriceCents(shelf, custom).markupCents, 1590, 'shelving is not listed, so the 10% default applies to 15900');
  assert.equal(computeSellPriceCents(shelf, settings({ markupPct: { default: 12.5, byCategory: {} } })).markupCents, 1988, '12.5% of 15900 = 1987.5 rounds half up');
});

test('rounding rule: half up to the cent by default, ceil when configured', () => {
  const oneMinute = { ...rack, installMinutes: 1 };
  assert.equal(computeSellPriceCents(oneMinute, settings({ laborRateCents: 7530 })).laborCents, 126, '7530/60 = 125.5 rounds half up');
  assert.equal(computeSellPriceCents(oneMinute, settings({ laborRateCents: 7529 })).laborCents, 125, '125.48 rounds down');
  assert.equal(computeSellPriceCents(oneMinute, settings({ laborRateCents: 7501, roundingRule: 'ceil_cent' })).laborCents, 126, '125.02 rounds up under ceil');
  assert.equal(computeSellPriceCents(oneMinute, settings({ laborRateCents: 7500, roundingRule: 'ceil_cent' })).laborCents, 125, 'whole cents are unchanged');
  const odd = { ...rack, retailPriceHighCents: 1001 };
  assert.equal(computeSellPriceCents(odd, settings({ markupPct: { default: 50, byCategory: {} } })).markupCents, 501, '500.5 rounds half up');
});

test('disposal applies only to haul-away items and only when enabled', () => {
  assert.equal(computeSellPriceCents(rack, settings({ includeDisposal: false })).disposalCents, 0);
  const hook = item('small-items-ladder-hook-everbilt-01219');
  assert.equal(hook.haulAwayApplicable, false);
  assert.equal(computeSellPriceCents(hook, defaults, { quantity: 4 }).disposalCents, 0);
  assert.equal(computeSellPriceCents(rack, settings({ disposalCentsPerItem: 2500 }), { quantity: 2 }).disposalCents, 5000);
});

test('small per-piece items are priced per batch, so one unit always has whole install minutes', () => {
  const tile = item('floor-tile-racedeck-free-flow-drain');
  assert.deepEqual([tile.priceUnit, tile.retailPriceHighCents, tile.installMinutes, tile.sqFtPerUnit, tile.haulAwayApplicable, 'installBatchSize' in tile], ['per 10 tiles (10 sq ft)', 3990, 12, 10, false, false]);
  // A 2-car floor of 450 tiles is 45 units: $39.90 + 12 min x $75/h = $15.00 + 20% markup $7.98 = $62.88 each.
  const line = catalogLine(tile, defaults, { quantity: 45 });
  assert.deepEqual(line.split, { productCents: 3990, laborCents: 1500, laborMinutes: 12, markupCents: 798, disposalCents: 0 });
  assert.deepEqual([line.unitCents, line.totalCents], [6288, 282960]);
  assert.deepEqual(lineFigures(computeSellPriceCents(tile, defaults, { quantity: 45 })), { productCents: 179550, laborCents: 67500, laborMinutes: 540, markupCents: 35910, disposalCents: 0, fixedCents: 0, totalCents: 282960 });
  const swisstrax = item('floor-tile-swisstrax-ribtrax-pro');
  assert.deepEqual([swisstrax.priceUnit, swisstrax.retailPriceHighCents, swisstrax.installMinutes], ['per 10 sq ft', 7750, 13]);
  assert.equal(computeSellPriceCents(swisstrax, defaults, { quantity: 120 }).laborMinutes, 1560, 'a 1,200 sq ft floor fits in one line');
  const bracket = item('shelving-everbilt-14337-bracket-diy-wall-shelf');
  assert.deepEqual([bracket.priceUnit, bracket.retailPriceHighCents, bracket.installMinutes, bracket.haulAwayApplicable], ['per set of 3 brackets (one 4 ft shelf)', 2979, 50, false]);
  assert.equal(catalogLine(bracket, defaults, { quantity: 2 }).split.disposalCents, 0, 'no packaging charge on a bracket set');
});

test('every price carries its evidence so a quote builder can flag estimate-only lines', () => {
  const estimate = item('lawn-rack-storeyourboard-omni-tool'), unconfirmed = item('floor-tile-racedeck-free-flow-drain');
  assert.deepEqual([estimate.priceVerified, estimate.priceEvidence], [false, 'estimate']);
  assert.deepEqual(['priceVerified', 'priceEvidence'].map(key => computeSellPriceCents(estimate, defaults)[key]), [false, 'estimate']);
  assert.deepEqual(['priceVerified', 'priceEvidence'].map(key => computeSellPriceCents(unconfirmed, defaults)[key]), [false, 'unconfirmed_snippet']);
  assert.deepEqual(['priceVerified', 'priceEvidence'].map(key => computeSellPriceCents(item('svc-labeled-tote'), defaults)[key]), [true, 'egc_price_list']);
});

test('the minimum job charge applies at the quote level', () => {
  const small = computeSellPriceCents(item('small-items-ladder-hook-everbilt-01219'), defaults, { quantity: 2 });
  assert.equal(small.totalCents, 1846, 'the GARAGE-CATALOG.md example: 2 x ($2.48 + 5 min labor $6.25 + markup $0.496 -> $0.50)');
  assert.equal(applyMinimum(small.totalCents, defaults), 45000);
  assert.equal(applyMinimum(39399 + small.totalCents, defaults), 45000, 'a rack plus two hooks ($412.45) is raised to the placeholder minimum');
  assert.equal(applyMinimum(39399 + 39399, defaults), 78798, 'above the minimum the total is unchanged');
  assert.equal(applyMinimum(0, settings({ minimumJobCents: 0 })), 0);
  for (const bad of [-1, 1.5, '45000', NaN]) assert.throws(() => applyMinimum(bad, defaults), { code: 'catalog_pricing_invalid' });
});

test('hidden and referral-only items cannot be priced for a quote', () => {
  for (const id of ['overhead-lift-onrax-motorized', 'coating-pro-epoxy-referral']) {
    assert.throws(() => computeSellPriceCents(item(id), defaults), error => error.code === 'catalog_item_not_quotable' && error.status === 409 && error.details.itemId === id);
  }
});

test('invalid options and settings are rejected before any math', () => {
  for (const options of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: 10001 }, { quantity: '2' }, { productCostCents: -1 }, { productCostCents: 12.5 }, { customerSupplied: 'yes' }, { discount: 10 }]) {
    for (const price of [computeSellPriceCents, catalogLine]) assert.throws(() => price(rack, defaults, options), { code: 'catalog_pricing_invalid' }, `${price.name} ${JSON.stringify(options)}`);
  }
  assert.equal(computeSellPriceCents(item('small-items-ladder-hook-everbilt-01219'), defaults, { quantity: 10000 }).quantity, 10000, 'the LI-CORE quantity limit');
  assert.throws(() => catalogLine(rack, defaults, { quantity: 10000 }), error => error.code === 'catalog_pricing_invalid' && /1,000,000/.test(error.message), 'a line over the LI-CORE $1,000,000 line limit');
  assert.throws(() => computeSellPriceCents(rack, settings({ roundingRule: 'nearest' })), { code: 'catalog_settings_invalid' });
  assert.throws(() => computeSellPriceCents(null, defaults), { code: 'catalog_pricing_invalid' });
  assert.throws(() => computeSellPriceCents({ ...rack, category: 'services' }, defaults), { code: 'catalog_pricing_invalid' });
});

test('every active item meets the LI-CORE line contract at any quantity', () => {
  let priced = 0;
  for (const entry of catalog.items.filter(candidate => candidate.availability === 'active')) {
    assert.match(entry.id, LI_CORE_ID, `${entry.id} works as a LI-CORE catalog itemId`);
    for (const quantity of [1, 2, 3, 7, 45]) {
      const at = `${entry.id} x${quantity}`, price = computeSellPriceCents(entry, defaults, { quantity }), line = catalogLine(entry, defaults, { quantity });
      for (const key of SPLIT_KEYS) assert.ok(Number.isSafeInteger(price[key]) && price[key] >= 0, `${at} ${key}`);
      assert.equal(price.totalCents, price.productCents + price.laborCents + price.markupCents + price.disposalCents + price.fixedCents, at);
      assert.deepEqual(Object.keys(line).filter(key => !LI_CORE_FIELDS.includes(key)), [], `${at} emits only LI-CORE line fields`);
      assert.ok(line.name.length <= 160, at);
      assert.equal(line.totalCents, line.unitCents * quantity, at);
      assert.equal(line.totalCents % quantity, 0, at);
      assert.ok(line.totalCents <= LI_CORE_MAX_LINE_CENTS, at);
      assert.deepEqual([price.unitCents, price.totalCents], [line.unitCents, line.totalCents], `${at} both views agree`);
      assert.equal(line.durationMinutes, entry.installMinutes, at);
      assert.ok(Number.isSafeInteger(line.durationMinutes) && line.durationMinutes <= LI_CORE_MAX_UNIT_MINUTES, at);
      if (entry.kind === 'service') {
        assert.equal(line.split, null, at);
        assert.equal(line.unitCents, entry.fixedPriceCents, at);
        continue;
      }
      assert.deepEqual(Object.keys(line.split), LI_CORE_SPLIT, at);
      for (const key of LI_CORE_SPLIT) {
        assert.ok(Number.isSafeInteger(line.split[key]) && line.split[key] >= 0, `${at} split.${key}`);
        assert.equal(price[key], line.split[key] * quantity, `${at} ${key} is the unit figure x quantity`);
      }
      assert.equal(line.split.productCents + line.split.laborCents + line.split.markupCents + line.split.disposalCents, line.unitCents, `${at} split sums to the unit price`);
      assert.ok(line.split.laborMinutes <= LI_CORE_MAX_UNIT_MINUTES, at);
      if (quantity === 1) assert.equal(price.productCents, entry.retailPriceHighCents, entry.id);
    }
    priced += 1;
  }
  assert.ok(priced > 230);
});

// Legacy walkthrough pricing, run from crew/gameplan.html itself.
const html = fs.readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
const line = prefix => html.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
// PRICE-SCRUB: the page prices with the tables /api/pricing-config builds from this catalog.
function gameplan(overrides = {}) {
  const context = vm.createContext({ PRICING: servedPricing() });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { garageSize: '1', fill: 'medium', loads: '1', crewSize: '2' }, overrides);
  for (const prefix of ['function recommend(', 'function estimatedJobMinutes(']) vm.runInContext(line(prefix), context);
  return context;
}
// The documented legacy rule: before-rounding services join the $25 rounding and $450 floor; the others are added after.
const legacyTotalDollars = (baseDollars, lines) => {
  const cents = lines.map(([id, qty]) => [item(id), computeSellPriceCents(item(id), defaults, { quantity: qty }).totalCents]);
  const before = cents.filter(([svc]) => svc.legacy.appliedBeforeRounding).reduce((sum, [, c]) => sum + c, 0) / 100;
  const after = cents.filter(([svc]) => !svc.legacy.appliedBeforeRounding).reduce((sum, [, c]) => sum + c, 0) / 100;
  return Math.max(450, Math.round((baseDollars + before) / 25) * 25) + after;
};

test('legacy service items keep today\'s fixed prices exactly', () => {
  const expected = { 'svc-pressure-wash-1car': 40000, 'svc-mouse-trapping': 25000, 'svc-pest-waste': 20000, 'svc-shelving-unit-metal': 49900, 'svc-shelving-unit-wood': 44900, 'svc-shelving-unit-plastic': 34900, 'svc-labeled-tote': 2150, 'svc-deep-clean-1car': 12500, 'svc-deep-clean-2car': 22000, 'svc-deep-clean-3car': 32000, 'svc-deep-clean-large': 42000 };
  assert.deepEqual(Object.fromEntries(catalog.items.filter(entry => entry.kind === 'service').map(entry => [entry.id, entry.fixedPriceCents])), expected);
  for (const [id, cents] of Object.entries(expected)) {
    assert.deepEqual(computeSellPriceCents(item(id), defaults, { quantity: 2 }), { productCents: 0, laborCents: 0, laborMinutes: item(id).installMinutes * 2, markupCents: 0, disposalCents: 0, fixedCents: cents * 2, totalCents: cents * 2, unitCents: cents, quantity: 2, priceVerified: true, priceEvidence: 'egc_price_list' });
    assert.deepEqual(catalogLine(item(id), defaults, { quantity: 2 }), { kind: 'service', name: item(id).name, quantity: 2, unitCents: cents, totalCents: cents * 2, customerSupplied: false, split: null, durationMinutes: item(id).installMinutes });
  }
  assert.deepEqual(['plastic', 'wood', 'metal'].map(type => item(`svc-shelving-unit-${type}`).tier), ['good', 'better', 'best']);
  assert.throws(() => computeSellPriceCents(item('svc-shelving-unit-metal'), defaults, { customerSupplied: true }), { code: 'catalog_pricing_invalid' });
  assert.throws(() => computeSellPriceCents(item('svc-pest-waste'), defaults, { productCostCents: 100 }), { code: 'catalog_pricing_invalid' });
});

test('catalog service prices reproduce recommend() totals from crew/gameplan.html', () => {
  const base = gameplan().recommend();
  assert.equal(base, 1000, 'one load, nothing extra');
  assert.equal(gameplan({ finish: ['cleanout', 'pressure_wash'] }).recommend(), legacyTotalDollars(base, [['svc-pressure-wash-1car', 1]]));
  assert.equal(gameplan({ finish: ['cleanout', 'mouse_trapping'] }).recommend(), legacyTotalDollars(base, [['svc-mouse-trapping', 1]]));
  assert.equal(gameplan({ hazards: ['Pest waste'] }).recommend(), legacyTotalDollars(base, [['svc-pest-waste', 1]]));
  for (const [size, id] of [['1', 'svc-deep-clean-1car'], ['2', 'svc-deep-clean-2car'], ['3', 'svc-deep-clean-3car'], ['other', 'svc-deep-clean-large']]) {
    const sizedBase = gameplan({ garageSize: size }).recommend();
    assert.equal(sizedBase % 25, 0, 'a base that needs no rounding of its own');
    assert.equal(gameplan({ garageSize: size, finish: ['cleanout', 'deep_clean'] }).recommend(), legacyTotalDollars(sizedBase, [[id, 1]]), size);
  }
  for (const type of ['metal', 'wood', 'plastic']) for (const qty of [1, 2, 3]) {
    assert.equal(gameplan({ finish: ['cleanout', 'shelving'], shelfType: type, shelfQty: qty }).recommend(), legacyTotalDollars(base, [[`svc-shelving-unit-${type}`, qty]]), `${type} x${qty}`);
  }
  for (const qty of [1, 4, 12]) assert.equal(gameplan({ finish: ['cleanout', 'totes'], toteQty: qty }).recommend(), legacyTotalDollars(base, [['svc-labeled-tote', qty]]), `totes x${qty}`);
  const everything = gameplan({ finish: ['cleanout', 'pressure_wash', 'deep_clean', 'shelving', 'totes', 'mouse_trapping'], hazards: ['Pest waste'], shelfType: 'wood', shelfQty: 2, toteQty: 6 });
  assert.equal(everything.recommend(), legacyTotalDollars(base, [['svc-pressure-wash-1car', 1], ['svc-deep-clean-1car', 1], ['svc-shelving-unit-wood', 2], ['svc-labeled-tote', 6], ['svc-mouse-trapping', 1], ['svc-pest-waste', 1]]));
  assert.equal(everything.recommend(), 3000, 'pinned: 1000 + 400 + 125 + 898 + 129 = 2552 rounds to 2550, then + 250 trapping + 200 pest waste');
});

test('legacy service minutes match estimatedJobMinutes() at the default 2-person crew', () => {
  const base = gameplan().estimatedJobMinutes();
  assert.equal(base, 180);
  const cases = [
    [{ finish: ['cleanout', 'pressure_wash'] }, 'svc-pressure-wash-1car', 1],
    [{ finish: ['cleanout', 'deep_clean'] }, 'svc-deep-clean-1car', 1],
    [{ finish: ['cleanout', 'shelving'], shelfQty: 2 }, 'svc-shelving-unit-metal', 2],
    [{ finish: ['cleanout', 'totes'], toteQty: 15 }, 'svc-labeled-tote', 15],
    [{ finish: ['cleanout', 'mouse_trapping'] }, 'svc-mouse-trapping', 1],
  ];
  for (const [overrides, id, qty] of cases) {
    const svc = item(id), elapsed = gameplan(overrides).estimatedJobMinutes() - base;
    assert.equal(elapsed, svc.legacy.jobMinutes * qty, id);
    assert.equal(computeSellPriceCents(svc, defaults, { quantity: qty }).laborMinutes, elapsed * 2, `${id} person-minutes are twice the 2-person elapsed minutes`);
  }
  for (const [size, id] of [['2', 'svc-deep-clean-2car'], ['3', 'svc-deep-clean-3car'], ['other', 'svc-deep-clean-large']]) {
    const plain = gameplan({ garageSize: size }).estimatedJobMinutes(), cleaned = gameplan({ garageSize: size, finish: ['cleanout', 'deep_clean'] }).estimatedJobMinutes();
    assert.equal(cleaned - plain, item(id).legacy.jobMinutes, size);
  }
});
