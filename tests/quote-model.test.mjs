import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_LINE_FIELDS, MAX_LINE_CENTS, MAX_TOTAL_CENTS, applySelection, customerLineItem, depositCents, estimateChanged, estimateFingerprint, estimateTotals, exactCents, included, legacyLineItems, lineItemGroups, normalizeLineItems, packageTotals, quotedAmountCents, selectedTotalCents, singleLineItem, toLegacyLineItem, toWalkthroughLineItem, validateSelection } from '../functions/_lib/quote-model.js';

const strict = items => normalizeLineItems(items, { strict: true }).lineItems;
const line = (extra = {}) => ({ id: 'reset', kind: 'service', name: 'Synthetic garage reset', unitCents: 100000, ...extra });
const code = expected => error => { assert.equal(error.code, expected); assert.equal(error.status, 400); return true; };
const tiers = () => [
  line({ id: 'good', name: 'Good shelving', kind: 'product', unitCents: 30000, group: { id: 'shelves', label: 'Shelving', selection: 'single', required: true }, tier: 'good', package: 'Starter' }),
  line({ id: 'better', name: 'Better shelving', kind: 'product', unitCents: 50000, group: { id: 'shelves', label: 'Shelving', selection: 'single', required: true }, tier: 'better', package: 'Organized', selected: true }),
  line({ id: 'best', name: 'Best shelving', kind: 'product', unitCents: 90000, group: { id: 'shelves', label: 'Shelving', selection: 'single', required: true }, tier: 'best', package: 'Showroom' }),
];

test('canonical lines keep money in exact integer cents and mirror dollars for legacy readers', () => {
  const [a, b, c] = strict([line({ quantity: 3, unitCents: 33333 }), line({ id: 'dollars', unitCents: undefined, amount: 1000.01 }), line({ id: 'hours', kind: 'labor', quantity: 2.5, unitCents: 6000 })]);
  assert.equal(a.totalCents, 99999); assert.equal(a.amount, 999.99);
  assert.equal(b.totalCents, 100001); assert.equal(b.unitCents, 100001); assert.equal(b.amount, 1000.01);
  assert.equal(c.totalCents, 15000);
  assert.equal(exactCents(0.1 + 0.2), 30, 'float noise below a cent is not a half cent');
  for (const bad of [10.005, '10.005', '1,200', '$12', -1, true, null, NaN, Infinity]) assert.equal(exactCents(bad), null, String(bad));
  assert.throws(() => strict([line({ unitCents: undefined, amount: 10.005 })]), code('quote_invalid_amount'));
  assert.equal(estimateTotals([line({ quantity: 3, unitCents: 33333 })]).totalCents, 99999);
});

test('invalid shapes are rejected with quote_ codes in strict mode', () => {
  const cases = [
    ['quote_invalid_line_items', { not: 'a list' }],
    ['quote_invalid_line_item', [null]],
    ['quote_invalid_id', [line({ id: 'bad id!' })]],
    ['quote_invalid_id', [line({ id: '__proto__' })]],
    ['quote_duplicate_id', [line(), line()]],
    ['quote_invalid_kind', [line({ kind: 'adjustment' })]],
    ['quote_invalid_name', [line({ name: '   ' })]],
    ['quote_invalid_name', [line({ name: 'x'.repeat(161) })]],
    ['quote_invalid_text', [line({ description: 'x'.repeat(601) })]],
    ['quote_negative_amount', [line({ unitCents: -500 })]],
    ['quote_invalid_quantity', [line({ quantity: 0 })]],
    ['quote_invalid_quantity', [line({ quantity: 1.005 })]],
    ['quote_invalid_quantity', [line({ quantity: '2' })]],
    ['quote_fractional_cents', [line({ unitCents: 333, quantity: 1.5 })]],
    ['quote_amount_mismatch', [line({ unitCents: 1000, totalCents: 2000 })]],
    ['quote_amount_mismatch', [line({ unitCents: undefined, totalCents: 1000, amount: 11 })]],
    ['quote_unit_price_required', [line({ unitCents: undefined, totalCents: 1000, quantity: 3 })]],
    ['quote_amount_required', [line({ unitCents: undefined })]],
    ['quote_invalid_amount', [line({ unitCents: 12.5 })]],
    ['quote_unknown_field', [line({ price: 5 })]],
    ['quote_mixed_shape', [{ name: 'Mixed', qty: 1, amount: 10 }]],
    ['quote_invalid_group', [line({ group: { id: 'g', label: 'No selection mode' } })]],
    ['quote_group_inconsistent', [line({ id: 'a', group: { id: 'g', label: 'G', selection: 'single' } }), line({ id: 'b', group: { id: 'g', label: 'G', selection: 'multi' } })]],
    ['quote_group_single_violation', [line({ id: 'a', selected: true, group: { id: 'g', label: 'G', selection: 'single' } }), line({ id: 'b', selected: true, group: { id: 'g', label: 'G', selection: 'single' } })]],
    ['quote_invalid_tier', [line({ tier: 'premium', group: { id: 'g', label: 'G', selection: 'single' } })]],
    ['quote_tier_requires_group', [line({ tier: 'good' })]],
    ['quote_invalid_catalog', [line({ catalog: { itemId: 'shelf-1' } })]],
    ['quote_split_mismatch', [line({ split: { productCents: 1, laborCents: 1 } })]],
    ['quote_split_not_allowed', [line({ kind: 'discount', unitCents: 100, split: { laborCents: 100 } })]],
    ['quote_invalid_split', [line({ split: { laborCents: 100000, overhead: 1 } })]],
    ['quote_customer_supplied_product', [line({ kind: 'product', customerSupplied: true, split: { productCents: 40000, laborCents: 60000 } })]],
    ['quote_invalid_duration', [line({ durationMinutes: 30.5 })]],
    ['quote_invalid_flag', [line({ optional: 'yes' })]],
    ['quote_required_line_unselected', [line({ selected: false })]],
    ['quote_too_many_lines', Array.from({ length: 101 }, (_, index) => line({ id: `l${index}` }))],
    ['quote_discount_exceeds_subtotal', [line({ unitCents: 1000 }), line({ id: 'off', kind: 'discount', unitCents: 2000 })]],
  ];
  for (const [expected, items] of cases) assert.throws(() => normalizeLineItems(items, { strict: true }), code(expected), expected);
});

test('legacy estimate and walkthrough shapes are read without throwing and flagged', () => {
  const estimate = normalizeLineItems([{ name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, amount: 1400 }]);
  const walkthrough = normalizeLineItems([{ name: 'Garage transformation', qty: 1, total: 1400 }]);
  assert.equal(estimate.legacy, true); assert.equal(walkthrough.legacy, true);
  assert.deepEqual(estimate.issues, []); assert.deepEqual(walkthrough.issues, []);
  assert.deepEqual({ ...walkthrough.lineItems[0], description: 'Synthetic scope' }, estimate.lineItems[0]);
  assert.deepEqual(estimate.lineItems[0], { id: 'line-1', kind: 'service', name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, unitCents: 140000, totalCents: 140000, amount: 1400, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, split: null, durationMinutes: null, taxable: false });
  assert.deepEqual(toLegacyLineItem(estimate.lineItems[0]), { name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, amount: 1400 });
  assert.deepEqual(toWalkthroughLineItem(walkthrough.lineItems[0]), { name: 'Garage transformation', qty: 1, total: 1400 });
  assert.equal(normalizeLineItems([line()]).legacy, false);
});

test('damaged legacy data never throws: money stays unknown and every repair is reported', () => {
  const messy = [null, 'text', { amount: 'abc' }, { name: '', amount: -50 }, { name: 'Tip', qty: 0, total: '12.5' }, { name: 'Rounded', amount: 10.005 }, { name: 'Dup', amount: 1 }, { id: 'line-7', name: 'Dup', amount: 1, kind: 'service' }];
  let result;
  assert.doesNotThrow(() => { result = normalizeLineItems(messy); });
  const codes = result.issues.map(issue => issue.code);
  for (const expected of ['quote_invalid_line_item', 'quote_invalid_amount', 'quote_invalid_name', 'quote_negative_amount', 'quote_invalid_quantity', 'quote_amount_rounded', 'quote_duplicate_id']) assert.ok(codes.includes(expected), expected);
  const unknown = result.lineItems.find(item => item.id === 'line-3');
  assert.equal(unknown.totalCents, null); assert.equal(unknown.amount, null); assert.equal(unknown.name, 'Garage service');
  const refund = result.lineItems.find(item => item.id === 'line-4');
  assert.equal(refund.kind, 'discount'); assert.equal(refund.totalCents, -5000);
  assert.equal(result.lineItems.find(item => item.id === 'line-5').quantity, 1);
  assert.equal(result.lineItems.find(item => item.id === 'line-6').totalCents, 1001, 'moneyCents rounds a stored half cent (10.005 * 100 is 1000.5000000000001) and flags it');
  assert.deepEqual(result.lineItems.map(item => item.id).filter(id => id.startsWith('line-7')), ['line-7', 'line-7-2']);
  assert.equal(estimateTotals(messy).totalCents, null, 'an unknown included price makes the total unknown, never zero');
  assert.equal(estimateTotals(messy).complete, false);
  assert.deepEqual(normalizeLineItems('nope'), { lineItems: [], issues: [{ code: 'quote_invalid_line_items', message: 'Line items must be a list.' }], legacy: false });
  assert.deepEqual(normalizeLineItems(undefined), { lineItems: [], issues: [], legacy: false });
});

test('normalizing is idempotent for canonical, legacy and repaired lines', () => {
  const canonical = strict([...tiers(), line({ id: 'haul', kind: 'disposal', unitCents: 12500, optional: true, selected: true, split: { disposalCents: 10000, laborCents: 2500, laborMinutes: 30 }, catalog: { itemId: 'haul-away', version: 3 }, durationMinutes: 45, taxable: true })]);
  assert.deepEqual(strict(canonical), canonical);
  const legacy = normalizeLineItems([{ name: 'A', description: 'B', quantity: 2, amount: 300 }]).lineItems;
  assert.deepEqual(strict(legacy), legacy);
  const repaired = normalizeLineItems([{ amount: -20 }, { name: 'Odd', quantity: 3, amount: 10 }]).lineItems;
  assert.deepEqual(normalizeLineItems(repaired).lineItems, repaired);
});

test('discounts are stored negative and reduce the total without going below zero', () => {
  for (const discount of [line({ id: 'off', kind: 'discount', unitCents: 5000 }), line({ id: 'off', kind: 'discount', unitCents: -5000 }), { id: 'off', kind: 'discount', name: 'Neighbor discount', amount: -50 }, { id: 'off', kind: 'discount', name: 'Neighbor discount', amount: '-50.00' }]) {
    const [, off] = strict([line(), discount]);
    assert.equal(off.totalCents, -5000); assert.equal(off.unitCents, -5000); assert.equal(off.amount, -50);
    const totals = estimateTotals([line(), discount]);
    assert.equal(totals.subtotalCents, 100000); assert.equal(totals.discountCents, 5000); assert.equal(totals.totalCents, 95000);
  }
  const over = estimateTotals([line({ unitCents: 1000 }), line({ id: 'off', kind: 'discount', unitCents: 2500 })]);
  assert.equal(over.totalCents, 0);
  assert.equal(over.issues[0].code, 'quote_discount_exceeds_subtotal');
});

test('only required and selected lines count; tips never become revenue', () => {
  const items = [line(), line({ id: 'add', kind: 'product', name: 'Totes', unitCents: 20000, optional: true, selected: true }), line({ id: 'skip', kind: 'fee', name: 'Rush fee', unitCents: 15000, optional: true }),
    line({ id: 'epoxy', name: 'Epoxy', unitCents: 70000, group: { id: 'floors', label: 'Floors', selection: 'multi' } }), ...tiers(), line({ id: 'tip', kind: 'tip', name: 'Crew tip', unitCents: 4000 })];
  const totals = estimateTotals(items);
  assert.equal(totals.requiredCents, 100000);
  assert.equal(totals.selectedCents, 70000, 'selected optional add-on plus the chosen single-select tier');
  assert.equal(totals.subtotalCents, 170000);
  assert.equal(totals.optionalAvailableCents, 85000, 'unselected optional and multi-select add-ons; single-select alternatives are not additive');
  assert.equal(totals.tipCents, 4000);
  assert.equal(totals.totalCents, 170000);
  assert.equal(selectedTotalCents(items), 170000);
  assert.equal(totals.includedCount, 4);
});

test('cost split aggregates per unit times quantity, keeps every cent and zero-prices customer-supplied goods', () => {
  const totals = estimateTotals([
    line({ id: 'shelf', kind: 'product', quantity: 2, unitCents: 45000, split: { productCents: 30000, laborCents: 9000, markupCents: 6000, laborMinutes: 40 } }),
    line({ id: 'own', kind: 'product', name: 'Customer shelving install', customerSupplied: true, unitCents: 8000, split: { productCents: 0, laborCents: 8000, laborMinutes: 45 } }),
    line({ id: 'own-plain', kind: 'product', name: 'Customer bins placed', customerSupplied: true, unitCents: 1500 }),
    line({ id: 'dump', kind: 'disposal', unitCents: 17500 }), line({ id: 'bundle', unitCents: 50000 }), line({ id: 'half', kind: 'labor', quantity: 0.5, unitCents: 400, split: { productCents: 100, laborCents: 100, markupCents: 100, disposalCents: 100 } }),
  ]);
  assert.equal(totals.productCents, 60000 + 50);
  assert.equal(totals.markupCents, 12000 + 50);
  assert.equal(totals.laborCents, 18000 + 8000 + 1500 + 50);
  assert.equal(totals.disposalCents, 17500 + 50);
  assert.equal(totals.otherCents, 50000);
  assert.equal(totals.productCents + totals.laborCents + totals.disposalCents + totals.markupCents + totals.otherCents, totals.subtotalCents);
  assert.equal(totals.laborMinutes, 80 + 45);
  const odd = estimateTotals([line({ id: 'odd', quantity: 0.5, unitCents: 4, split: { productCents: 1, laborCents: 1, markupCents: 1, disposalCents: 1 } })]);
  assert.equal(odd.totalCents, 2);
  assert.ok(['productCents', 'laborCents', 'markupCents', 'disposalCents'].every(key => odd[key] >= 0));
  assert.equal(odd.productCents + odd.laborCents + odd.markupCents + odd.disposalCents, 2);
});

test('single-select groups allow one choice, multi-select many, and required groups need a choice', () => {
  const items = [...tiers().map(item => ({ ...item, selected: false })), line({ id: 'epoxy', unitCents: 70000, group: { id: 'floors', label: 'Floors', selection: 'multi' } }), line({ id: 'mats', unitCents: 9000, group: { id: 'floors', label: 'Floors', selection: 'multi' } }), line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: true })];
  assert.deepEqual(validateSelection(items, ['better', 'epoxy', 'mats', 'rush']), { ok: true, issues: [] });
  assert.deepEqual(validateSelection(items, ['good', 'best']).issues.map(issue => issue.code), ['quote_group_single_violation']);
  assert.deepEqual(validateSelection(items, ['epoxy']).issues.map(issue => [issue.code, issue.groupId]), [['quote_group_choice_required', 'shelves']]);
  assert.deepEqual(validateSelection(items, ['better', 'ghost', 'better']).issues.map(issue => issue.code), ['quote_selection_unknown', 'quote_selection_duplicate']);
  assert.equal(validateSelection(items, 'better').issues[0].code, 'quote_invalid_selection');
  assert.equal(validateSelection(items).issues[0].code, 'quote_group_choice_required', 'defaults to the saved selection');
  const groups = lineItemGroups(items);
  assert.deepEqual(groups.map(group => [group.id, group.selection, group.required, group.itemIds]), [['shelves', 'single', true, ['good', 'better', 'best']], ['floors', 'multi', false, ['epoxy', 'mats']]]);
  assert.equal(validateSelection(groups, ['best', 'mats']).ok, true);
  assert.equal(validateSelection(groups, []).issues[0].code, 'quote_group_choice_required');
  const chosen = applySelection(items, ['best', 'mats']);
  assert.deepEqual(chosen.filter(item => item.selected).map(item => item.id), ['best', 'mats']);
  assert.equal(estimateTotals(chosen).totalCents, 99000);
  assert.deepEqual(applySelection([line(), ...items], ['reset', 'good']).filter(item => item.selected).map(item => item.id), ['reset', 'good'], 'naming a required line is harmless');
  assert.throws(() => applySelection(items, ['mats']), error => error.code === 'quote_group_choice_required' && error.details.issues.length === 1);
});

test('good/better/best package totals are reported per option group and a package may span lines', () => {
  const shelves = { id: 'shelves', label: 'Shelving', selection: 'single', required: true };
  const items = [...tiers(), line({ id: 'best-bins', kind: 'product', unitCents: 12000, group: shelves, tier: 'best' }), line({ id: 'epoxy', unitCents: 70000, selected: true, group: { id: 'floors', label: 'Floors', selection: 'multi' } }), line({ id: 'mats', unitCents: 9000, group: { id: 'floors', label: 'Floors', selection: 'multi' }, tier: 'good' }), line({ id: 'tip', kind: 'tip', unitCents: 100, group: { id: 'floors', label: 'Floors', selection: 'multi' } })];
  assert.deepEqual(packageTotals(items).map(({ groupId, tiers: t, packages: names, selectedCents, selectedTier, untieredCents }) => ({ groupId, t, names, selectedCents, selectedTier, untieredCents })), [
    { groupId: 'shelves', t: { good: 30000, better: 50000, best: 102000 }, names: { good: 'Starter', better: 'Organized', best: 'Showroom' }, selectedCents: 50000, selectedTier: 'better', untieredCents: null },
    { groupId: 'floors', t: { good: 9000, better: null, best: null }, names: { good: null, better: null, best: null }, selectedCents: 70000, selectedTier: null, untieredCents: 70000 },
  ]);
  assert.equal(validateSelection(items, ['best', 'best-bins']).ok, true, 'choosing the best package selects both of its lines');
  assert.deepEqual(validateSelection(items, ['best']).issues.map(issue => issue.code), ['quote_package_incomplete']);
  assert.deepEqual(validateSelection(items, ['good', 'best', 'best-bins']).issues.map(issue => issue.code), ['quote_group_single_violation']);
  assert.equal(validateSelection(lineItemGroups(items), ['best', 'best-bins', 'mats', 'epoxy']).ok, true);
  assert.equal(estimateTotals(applySelection(items, ['best', 'best-bins'])).totalCents, 102000);
  assert.throws(() => normalizeLineItems(items.map(item => item.id === 'best' ? { ...item, selected: true } : { ...item, selected: item.id === 'best-bins' ? false : item.selected && item.id !== 'better' }), { strict: true }), code('quote_package_incomplete'));
  const repaired = normalizeLineItems(items.map(item => ['good', 'better'].includes(item.id) ? { ...item, selected: true } : item));
  assert.deepEqual(repaired.lineItems.filter(item => item.group?.id === 'shelves' && item.selected).map(item => item.id), ['good'], 'lenient reads keep the first choice');
  assert.equal(repaired.issues[0].code, 'quote_group_single_violation');
});

test('deposits round half cents up and match the legacy 50% default everywhere', () => {
  assert.equal(depositCents(100001), 50001, '1000.01 -> 500.01');
  assert.equal(depositCents(142500), 71250);
  assert.equal(depositCents(1), 1);
  assert.equal(depositCents(0), 0);
  assert.equal(depositCents(100000, 0), 0);
  assert.equal(depositCents(100000, 100), 100000);
  assert.equal(depositCents(100000, 33.33), 33330);
  assert.equal(depositCents(99999, 12.5), 12500);
  for (let total = 0; total <= 5000; total++) assert.equal(depositCents(total), Math.round(total / 2));
  for (const pct of [-1, 101, 12.345, '50', NaN]) assert.throws(() => depositCents(1000, pct), code('quote_invalid_deposit_percent'));
  for (const total of [-1, 10.5, '1000', null]) assert.throws(() => depositCents(total), code('quote_invalid_amount'));
});

test('a legacy job without lines maps to one required line equal to its estimate amount', () => {
  const job = { id: 'synthetic-job-1', type: 'job', serviceType: 'Garage transformation', total: 1425, estimate: { amount: 1425, scope: 'Synthetic reset scope', status: 'accepted' } };
  const portal = legacyLineItems(job);
  assert.equal(portal.source, 'synthesized'); assert.equal(portal.legacy, true); assert.deepEqual(portal.issues, []);
  assert.equal(portal.lineItems.length, 1);
  assert.deepEqual(toLegacyLineItem(portal.lineItems[0]), { name: 'Garage transformation', description: 'Synthetic reset scope', quantity: 1, amount: 1425 });
  assert.equal(portal.lineItems[0].optional, false); assert.equal(portal.lineItems[0].selected, true);
  assert.equal(estimateTotals(portal.lineItems).totalCents, 142500);
  assert.equal(quotedAmountCents(job), 142500);
  assert.deepEqual(toLegacyLineItem(legacyLineItems({ id: 'x', type: 'cleanout', priceQuoted: 900 }).lineItems[0]), { name: 'cleanout', description: '', quantity: 1, amount: 900 });
  assert.deepEqual(toLegacyLineItem(legacyLineItems({ id: 'x', scopeSummary: 'Summary', total: 900 }, { record: 'invoice', surface: 'document' }).lineItems[0]), { name: 'Garage transformation', description: 'Summary', quantity: 1, amount: 900 });
  const unpriced = legacyLineItems({ id: 'x', estimate: { amount: 'TBD' } });
  assert.equal(unpriced.lineItems[0].totalCents, null); assert.equal(unpriced.issues[0].code, 'quote_invalid_amount');
  const saved = legacyLineItems({ ...job, estimate: { ...job.estimate, lineItems: [{ name: 'Saved line', description: '', quantity: 1, amount: 1425 }] } });
  assert.equal(saved.source, 'record'); assert.equal(saved.lineItems[0].name, 'Saved line');
});

test('the estimate fingerprint catches line-item and selection changes and ignores key order', () => {
  const base = { amount: 1800, depositRequired: 900, scope: 'Synthetic scope', lineItems: [line({ unitCents: 100000 }), ...tiers(), line({ id: 'rush', kind: 'fee', unitCents: 30000, optional: true })] };
  const reordered = { scope: base.scope, lineItems: base.lineItems.map(item => Object.fromEntries(Object.entries(item).reverse())), depositRequired: 900, amount: 1800 };
  assert.match(estimateFingerprint(base), /^[0-9a-f]{64}$/);
  assert.equal(estimateFingerprint(reordered), estimateFingerprint(base));
  assert.equal(estimateChanged(base, reordered), false);
  assert.equal(estimateChanged(base, { ...base, lineItems: base.lineItems.map(item => item.id === 'reset' ? { ...item, description: 'Now includes the attic' } : item) }), true, 'a lineItems-only change is material');
  assert.equal(estimateChanged(base, { ...base, lineItems: base.lineItems.map(item => item.id === 'rush' ? { ...item, selected: true } : item) }), true);
  assert.equal(estimateChanged(base, { ...base, selectedIds: ['best'] }), true, 'a separate selection list is part of the fingerprint');
  assert.equal(estimateChanged({ ...base, selectedIds: ['better'] }, base), false);
  assert.equal(estimateChanged(base, { ...base, depositRequired: 1000 }), true);
  assert.equal(estimateChanged(base, { ...base, scope: 'Different scope' }), true);
  assert.equal(estimateChanged(base, { ...base, amount: 1900 }), true);
  assert.equal(estimateChanged(base, { ...base, lineItems: base.lineItems.map(item => item.id === 'reset' ? { ...item, durationMinutes: 90, catalog: { itemId: 'reset', version: 2 } } : item) }), false, 'internal duration and catalog version are not customer-facing');
  const legacy = { amount: 1425, scope: 'S' };
  assert.equal(estimateChanged(legacy, { scope: 'S', amount: '1425.00' }), false);
  assert.equal(estimateChanged({ amount: 'abc' }, { amount: 'xyz' }), true, 'two different invalid amounts are not equal');
  assert.equal(estimateChanged(undefined, {}), false);
});

test('lenient repairs fail closed: malformed grouping or flags never make a declined line count', () => {
  const base = line({ id: 'base', name: 'Synthetic base reset' });
  const shelves = (group, extra = {}) => [
    line({ id: 'good', name: 'Good shelving', kind: 'product', unitCents: 30000, group, tier: 'good', selected: false, ...extra }),
    line({ id: 'better', name: 'Better shelving', kind: 'product', unitCents: 50000, group, tier: 'better', selected: true, ...extra }),
    line({ id: 'best', name: 'Best shelving', kind: 'product', unitCents: 90000, group, tier: 'best', selected: false, ...extra }),
  ];
  const valid = { id: 'shelves', label: 'Shelving', selection: 'single', required: true };
  assert.equal(estimateTotals([base, ...shelves(valid)]).totalCents, 150000, 'control: base plus the chosen better tier');
  const malformed = [
    ['quote_invalid_group', { ...valid, sort: 1 }], ['quote_invalid_group', { ...valid, id: 'bad id!' }], ['quote_invalid_group', { ...valid, selection: 'Single' }],
    ['quote_invalid_group', { ...valid, name: 'Different label' }], ['quote_invalid_group', 'shelves'], ['quote_invalid_flag', { ...valid, required: 'yes' }],
  ];
  for (const [expected, group] of malformed) {
    const items = [base, ...shelves(group)], totals = estimateTotals(items), { lineItems, issues } = normalizeLineItems(items);
    assert.equal(totals.totalCents, 100000, `${expected}: no alternative of a malformed group is counted (the probe gave 170000)`);
    assert.equal(totals.complete, false, expected);
    assert.ok(issues.some(issue => issue.code === expected), expected);
    assert.deepEqual(lineItems.slice(1).map(item => [item.group, item.optional, item.selected, included(item)]), Array(3).fill([null, true, false, false]), expected);
    assert.equal(selectedTotalCents(items), 100000);
    assert.deepEqual(normalizeLineItems(lineItems).lineItems, lineItems, 'the repair is stable when read again');
    assert.deepEqual(lineItemGroups(items), []);
    assert.throws(() => normalizeLineItems(items, { strict: true }), code(expected));
  }
  const flags = [
    ['quote_invalid_flag', line({ id: 'rush', kind: 'fee', unitCents: 15000, optional: 'true', selected: false })],
    ['quote_invalid_flag', line({ id: 'rush', kind: 'fee', unitCents: 15000, optional: 'true', selected: true })],
    ['quote_invalid_flag', line({ id: 'rush', kind: 'fee', unitCents: 15000, optional: 1 })],
    ['quote_invalid_flag', line({ id: 'rush', kind: 'fee', unitCents: 15000, selected: 'yes' })],
    ['quote_required_line_unselected', line({ id: 'rush', kind: 'fee', unitCents: 15000, selected: false })],
    ['quote_tier_requires_group', line({ id: 'rush', kind: 'fee', unitCents: 15000, tier: 'best', selected: true })],
  ];
  for (const [expected, item] of flags) {
    const totals = estimateTotals([base, item]), [, repaired] = normalizeLineItems([base, item]).lineItems;
    assert.equal(totals.totalCents, 100000, `${expected}: the declined or unreadable line adds nothing`);
    assert.equal(totals.optionalAvailableCents, 15000);
    assert.equal(totals.complete, false, expected);
    assert.ok(totals.issues.some(issue => issue.code === expected), expected);
    assert.deepEqual([repaired.optional, repaired.selected], [true, false], expected);
    assert.throws(() => normalizeLineItems([base, item], { strict: true }), code(expected));
  }
  const inconsistent = [base, line({ id: 'a', unitCents: 20000, selected: true, group: { id: 'g', label: 'G', selection: 'multi' } }), line({ id: 'b', unitCents: 30000, selected: true, group: { id: 'g', label: 'G', selection: 'single' } })];
  const read = normalizeLineItems(inconsistent);
  assert.deepEqual(read.lineItems.map(item => [item.id, item.group?.id ?? null, item.selected]), [['base', null, true], ['a', 'g', true], ['b', null, false]], 'an option that disagrees with its group is not a choice');
  assert.equal(estimateTotals(inconsistent).totalCents, 120000);
  assert.equal(estimateTotals(inconsistent).complete, false);
  const repairedSingle = estimateTotals([...tiers().map(item => ({ ...item, selected: true }))]);
  assert.equal(repairedSingle.totalCents, 30000, 'a single-select repair keeps only the first choice');
  assert.equal(repairedSingle.complete, false, 'and the totals say they were repaired');
  const cosmetic = estimateTotals([line({ description: 'x'.repeat(700), catalog: { itemId: 'shelf' }, durationMinutes: 1.5 })]);
  assert.deepEqual([cosmetic.totalCents, cosmetic.complete], [100000, true], 'text, catalog and duration repairs cannot change money');
});

test('strict validation caps unitCents x quantity at MAX_LINE_CENTS and the estimate total at MAX_TOTAL_CENTS', () => {
  assert.equal(MAX_LINE_CENTS, 100000000); assert.equal(MAX_TOTAL_CENTS, 100000000, 'the $1,000,000 cents() convention');
  for (const extra of [{ unitCents: MAX_LINE_CENTS, quantity: 10000 }, { unitCents: MAX_LINE_CENTS, quantity: 1.5 }, { unitCents: 60000000, quantity: 2 }, { unitCents: undefined, totalCents: MAX_LINE_CENTS, quantity: 0.5 }, { unitCents: undefined, amount: 1000000, quantity: 0.25 }]) {
    assert.throws(() => strict([line(extra)]), code('quote_invalid_amount'), JSON.stringify(extra));
  }
  assert.equal(strict([line({ unitCents: MAX_LINE_CENTS })])[0].totalCents, MAX_LINE_CENTS, 'exactly $1,000,000 is allowed');
  assert.equal(strict([line({ unitCents: 50000000, quantity: 2 })])[0].totalCents, MAX_LINE_CENTS);
  assert.throws(() => strict([line({ unitCents: 60000000 }), line({ id: 'second', unitCents: 60000000 })]), code('quote_total_too_large'));
  assert.throws(() => strict([line({ id: 'tip-a', kind: 'tip', unitCents: 60000000 }), line({ id: 'tip-b', kind: 'tip', unitCents: 60000000 })]), code('quote_total_too_large'));
  assert.doesNotThrow(() => strict([line({ unitCents: 60000000 }), line({ id: 'second', unitCents: 40000000 }), line({ id: 'extra', unitCents: 60000000, optional: true })]), 'an unselected option is not part of the total');
  const lenient = normalizeLineItems([line({ unitCents: MAX_LINE_CENTS, quantity: 10000 })]);
  assert.deepEqual([lenient.lineItems[0].unitCents, lenient.lineItems[0].totalCents, lenient.issues[0].code], [MAX_LINE_CENTS, null, 'quote_invalid_amount'], 'a derived total over the cap stays unknown');
  assert.equal(estimateTotals([line({ unitCents: MAX_LINE_CENTS, quantity: 10000 })]).totalCents, null);
  const over = estimateTotals([line({ unitCents: 60000000 }), line({ id: 'second', unitCents: 60000000 })]);
  assert.equal(over.subtotalCents, 120000000); assert.equal(over.totalCents, null); assert.equal(over.complete, false);
  assert.ok(over.issues.some(issue => issue.code === 'quote_total_too_large'));
  const options = [line({ unitCents: 60000000 }), line({ id: 'upgrade', unitCents: 60000000, optional: true })];
  assert.throws(() => applySelection(options, ['upgrade']), code('quote_total_too_large'), 'a customer choice cannot push the total past the cap');
  assert.equal(estimateTotals(applySelection(options, [])).totalCents, 60000000);
  assert.equal(depositCents(MAX_TOTAL_CENTS), 50000000);
  assert.throws(() => depositCents(MAX_TOTAL_CENTS + 1), code('quote_invalid_amount'));
  assert.equal(quotedAmountCents({ estimate: { amount: 1000000 } }), MAX_TOTAL_CENTS);
  assert.equal(quotedAmountCents({ estimate: { amount: 1000000.01 } }), null, 'a saved quote above the cap is unknown');
});

test('validateSelection gives the same answer for line items and for lineItemGroups(items, {includeUngrouped:true})', () => {
  const floors = { id: 'floors', label: 'Floors', selection: 'multi' }, shelves = { id: 'shelves', label: 'Shelving', selection: 'single', required: true };
  const items = [line(), ...tiers(), line({ id: 'best-bins', kind: 'product', unitCents: 12000, group: shelves, tier: 'best' }), line({ id: 'epoxy', unitCents: 70000, group: floors }), line({ id: 'mats', unitCents: 9000, group: floors, selected: true }), line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: true }), line({ id: 'totes', kind: 'product', unitCents: 2150, optional: true, selected: true })];
  const full = lineItemGroups(items, { includeUngrouped: true });
  assert.deepEqual(full.at(-1), { id: null, ungrouped: true, label: 'Optional items', zone: null, selection: 'multi', required: false, itemIds: ['rush', 'totes'], selectedIds: ['totes'], itemTiers: { rush: null, totes: null }, fixedIds: ['reset'] });
  assert.deepEqual(lineItemGroups(items).map(group => group.id), ['shelves', 'floors'], 'the default form is unchanged');
  const pool = ['reset', 'good', 'better', 'best', 'best-bins', 'epoxy', 'mats', 'rush', 'totes', 'ghost'];
  const selections = [undefined, 'better', [3], ['better', 'better'], ['reset', 'better', 'rush'], ['ghost']];
  for (let mask = 0; mask < 1 << pool.length; mask += 7) selections.push(pool.filter((_, index) => mask & 1 << index));
  const wire = JSON.parse(JSON.stringify(full));
  for (const selection of selections) {
    const expected = validateSelection(items, selection);
    assert.deepEqual(validateSelection(full, selection), expected, JSON.stringify(selection));
    assert.deepEqual(validateSelection(wire, selection), expected, `after JSON: ${JSON.stringify(selection)}`);
  }
  assert.equal(validateSelection(items, ['reset', 'better', 'rush']).ok, true, 'optional and required ids are known');
  const optionalOnly = [line(), line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: true })];
  for (const selection of [['rush'], ['reset'], ['ghost'], []]) assert.deepEqual(validateSelection(lineItemGroups(optionalOnly, { includeUngrouped: true }), selection), validateSelection(optionalOnly, selection));
  assert.deepEqual(validateSelection(lineItemGroups(items), ['better', 'rush']).issues.map(issue => [issue.code, issue.itemId]), [['quote_selection_unknown', 'rush']], 'the default groups form covers group choices only, as documented');
});

test('the fingerprint covers every stored line, untruncated and unrepaired', () => {
  const many = Array.from({ length: 105 }, (_, index) => line({ id: `l${index}`, name: `Line ${index}`, unitCents: 1000 }));
  const base = { amount: 1050, scope: 'Synthetic scope', lineItems: many };
  const change = (index, patch) => ({ ...base, lineItems: base.lineItems.map((item, at) => at === index ? { ...item, ...patch } : item) });
  assert.equal(estimateChanged(base, change(101, { unitCents: 2000 })), true, 'a price change on line 102 is detected');
  assert.equal(estimateChanged(base, change(104, { optional: true })), true);
  assert.equal(estimateChanged(base, { ...base, lineItems: many.slice(0, 104) }), true, 'dropping a line past the cap is detected');
  assert.equal(estimateChanged(base, change(101, { durationMinutes: 45, catalog: { itemId: 'x', version: 1 }, split: { laborCents: 1000 } })), false, 'internal fields stay out, even past the cap');
  assert.equal(estimateChanged(base, { ...base, lineItems: base.lineItems.map(item => Object.fromEntries(Object.entries(item).reverse())) }), false, 'key order is still irrelevant');
  const long = { amount: 10, lineItems: [line({ description: `${'x'.repeat(600)}A` })] };
  assert.equal(estimateChanged(long, { ...long, lineItems: [line({ description: `${'x'.repeat(600)}B` })] }), true, 'text past the 600 character cap');
  assert.equal(estimateChanged({ lineItems: [line({ name: `${'n'.repeat(160)}A` })] }, { lineItems: [line({ name: `${'n'.repeat(160)}B` })] }), true, 'names past the 160 character cap');
  const legacy = amount => ({ lineItems: [{ name: 'Synthetic', quantity: 1, amount }] });
  assert.equal(estimateChanged(legacy('abc'), legacy('xyz')), true, 'two different unreadable line amounts');
  assert.equal(estimateChanged(legacy(NaN), legacy(null)), true);
  assert.equal(estimateChanged({ lineItems: [{ name: 'Q', quantity: 'abc', amount: 10 }] }, { lineItems: [{ name: 'Q', quantity: 'xyz', amount: 10 }] }), true, 'two different invalid quantities');
  assert.equal(estimateChanged({ lineItems: [{ name: 'U', amount: 10, note: 'a' }] }, { lineItems: [{ name: 'U', amount: 10, note: 'b' }] }), true, 'unknown stored fields');
  assert.equal(estimateChanged({ scope: `${'s'.repeat(1600)}A` }, { scope: `${'s'.repeat(1600)}B` }), true, 'scope past 1600 characters');
  const options = { ...base, lineItems: [...many, line({ id: 'late-option', unitCents: 500, optional: true })] };
  assert.equal(estimateChanged(options, { ...options, selectedIds: ['late-option'] }), true, 'a selection past the cap is detected');
  assert.equal(estimateChanged({ ...options, selectedIds: [] }, options), false);
});

test('customer projections and the Hub invoice fallback naming', () => {
  const [full] = strict([line({ kind: 'product', optional: true, selected: true, group: { id: 'g', label: 'G', selection: 'multi' }, tier: 'good', package: 'Starter', catalog: { itemId: 'shelf', version: 2 }, split: { productCents: 60000, laborCents: 30000, markupCents: 10000, laborMinutes: 40 }, durationMinutes: 50, taxable: true })]);
  const projected = customerLineItem(full);
  assert.deepEqual(Object.keys(projected), [...CUSTOMER_LINE_FIELDS]);
  assert.deepEqual(projected, { id: 'reset', kind: 'product', name: 'Synthetic garage reset', description: '', quantity: 1, unitCents: 100000, totalCents: 100000, amount: 1000, optional: true, selected: true, taxable: true });
  assert.doesNotMatch(JSON.stringify(projected), /markup|split|catalog|duration|labor|group|package|tier/i);
  const job = { id: 'x', type: 'cleanout', scopeSummary: 'Summary', total: 900 };
  assert.deepEqual(toLegacyLineItem(singleLineItem(job, { surface: 'invoice' })), { name: 'Garage transformation', description: 'Summary', quantity: 1, amount: 900 }, 'never the job type');
  assert.deepEqual(toLegacyLineItem(singleLineItem({ ...job, scopeSummary: '' }, { surface: 'invoice' })), { name: 'Garage transformation', description: '', quantity: 1, amount: 900 });
  assert.equal(singleLineItem({ ...job, serviceType: 'Garage makeover' }, { surface: 'invoice' }).name, 'Garage makeover');
  assert.equal(singleLineItem(job).name, 'cleanout', 'the portal surface is unchanged');
  assert.equal(legacyLineItems({ id: 'x', estimate: { lineItems: [{ amount: 10 }] } }, { surface: 'invoice' }).lineItems[0].name, 'Garage transformation');
});

test('a dated catalog release (YYYY-MM-DD.N) is a valid catalog version for a real catalogLine() output', async () => {
  const { readFileSync } = await import('node:fs');
  const { catalogLine } = await import('../functions/_lib/catalog.js');
  const catalog = JSON.parse(readFileSync(new URL('../functions/_data/garage-catalog.json', import.meta.url), 'utf8'));
  const settings = JSON.parse(readFileSync(new URL('../functions/_data/pricing-settings.defaults.json', import.meta.url), 'utf8'));
  assert.match(catalog.catalogVersion, /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/);
  const item = catalog.items.find(row => row.kind === 'product' && row.availability === 'active');
  assert.ok(item, 'the catalog has an active product');
  const reference = { itemId: item.id, version: catalog.catalogVersion };
  const [normalized] = strict([{ id: 'catalog-line', ...catalogLine(item, settings, { quantity: 3 }), catalog: reference }]);
  assert.deepEqual(normalized.catalog, reference);
  assert.equal(normalized.totalCents, normalized.unitCents * 3);
  assert.equal(estimateTotals([{ id: 'catalog-line', ...catalogLine(item, settings), catalog: reference }]).complete, true);
  for (const version of ['2026-9-27.1', '2026-09-27.', '2026-09-27.1234', '2026-09-27.1 ', '2026-09-27.1.2', 0, -1, 1.5])
    assert.throws(() => strict([line({ catalog: { itemId: item.id, version } })]), code('quote_invalid_catalog'), String(version));
  assert.equal(strict([line({ catalog: { itemId: item.id, version: 3 } })])[0].catalog.version, 3, 'integer versions still work');
  assert.equal(strict([line({ catalog: { itemId: item.id, version: 'v2' } })])[0].catalog.version, 'v2', 'id versions still work');
});
