import { sha256 } from '@noble/hashes/sha2.js';
import { moneyCents } from './operations-financials.js';

/**
 * Canonical quote line-item model. Pure: no I/O and no clock.
 *
 * One line shape serves estimates, invoices, the customer portal, catalog
 * pricing, dispatch duration and MCP:
 *   {id, kind, name, description, quantity, unitCents, totalCents, amount,
 *    optional, selected, group:{id,label,zone,selection,required}|null,
 *    tier:'good'|'better'|'best'|null, package, catalog:{itemId,version}|null,
 *    customerSupplied, split:{productCents,laborCents,laborMinutes,markupCents,
 *    disposalCents}|null, durationMinutes, taxable}
 *
 * Money is integer cents. `amount` is the line total in dollars, kept because
 * today's portal, print and invoice readers display lineItems[].amount.
 * `split` and `durationMinutes` describe ONE unit; line figures multiply by
 * quantity. Discount lines are stored negative; tip lines are never revenue.
 *
 * A line is included in the total when it is required (not optional and not
 * grouped) or when it is selected. Single-select groups hold alternatives
 * (e.g. good/better/best, where one tier may span several lines that are
 * chosen together), multi-select groups hold add-ons.
 *
 * normalizeLineItems() reads both legacy shapes, the estimate/invoice
 * {name,description,quantity,amount} and the walkthrough {name,qty,total},
 * without throwing: repairs are reported in `issues` and `legacy` is flagged.
 * With {strict:true} (builder/API writes) the first problem throws a quote_*
 * error instead. Unknown money stays null (moneyCents semantics), never 0.
 *
 * Lenient repairs fail closed: a line whose inclusion data is malformed (a bad
 * or inconsistent group, a non-boolean optional/selected flag, a tier without
 * a group, or a required line saved as unselected) is read as optional and
 * NOT selected, so a line whose choice cannot be read is never counted as
 * chosen (its siblings in a package, discounts included, are treated alike).
 * estimateTotals() then reports complete:false and callers must not present
 * those totals as final (invoiceLineItems falls back to the saved quote).
 *
 * Money caps follow the $1,000,000 cents() convention: a line total (stored or
 * unitCents x quantity) is at most MAX_LINE_CENTS and an estimate total at most
 * MAX_TOTAL_CENTS.
 */

export const LINE_KINDS = Object.freeze(['service', 'product', 'labor', 'disposal', 'fee', 'discount', 'tip']);
export const TIERS = Object.freeze(['good', 'better', 'best']);
export const MAX_LINE_ITEMS = 100;
export const MAX_LINE_CENTS = 100000000;
export const MAX_TOTAL_CENTS = 100000000;
export const MAX_QUANTITY = 10000;
/** The only line fields a customer document (invoice, receipt) may carry. */
export const CUSTOMER_LINE_FIELDS = Object.freeze(['id', 'kind', 'name', 'description', 'quantity', 'unitCents', 'totalCents', 'amount', 'optional', 'selected', 'taxable']);
const FIELDS = ['id', 'kind', 'name', 'description', 'quantity', 'unitCents', 'totalCents', 'amount', 'optional', 'selected', 'group', 'tier', 'package', 'catalog', 'customerSupplied', 'split', 'durationMinutes', 'taxable'];
// Internal cost and scheduling data: never customer-facing, never fingerprinted.
const INTERNAL_FIELDS = new Set(['split', 'catalog', 'durationMinutes']);
// Repairs that cannot change what is charged, included or attributed.
const COSMETIC_ISSUES = new Set(['quote_invalid_text', 'quote_invalid_name', 'quote_invalid_id', 'quote_duplicate_id', 'quote_invalid_catalog', 'quote_invalid_duration', 'quote_unknown_field']);
const WALKTHROUGH_FIELDS = ['name', 'description', 'qty', 'total'];
const SPLIT_CENTS = ['productCents', 'laborCents', 'markupCents', 'disposalCents'];
const SPLIT_FIELDS = [...SPLIT_CENTS, 'laborMinutes'];
const GROUP_FIELDS = ['id', 'label', 'name', 'zone', 'selection', 'required'];
const MATERIAL = ['id', 'kind', 'name', 'description', 'quantity', 'unitCents', 'totalCents', 'optional', 'selected', 'group', 'tier', 'package', 'customerSupplied', 'taxable'];
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => Object.assign(new Error(message), { code: `quote_${code}`, status: 400, ...(details ? { details } : {}) });
const clean = (value, max) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const safeId = value => typeof value === 'string' && ID.test(value) && !RESERVED.has(value);
const negative = cents => cents === 0 ? 0 : -Math.abs(cents);
const hundredths = quantity => Math.round(quantity * 100);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
// Lossless variant for fingerprints: undefined, NaN and Infinity stay distinct
// from null and from any string (bare tokens can never collide with JSON text).
const exactCanonical = value => {
  if (Array.isArray(value)) return `[${value.map(exactCanonical).join(',')}]`;
  if (value instanceof Date) return `date(${value.getTime()})`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${exactCanonical(value[key])}`).join(',')}}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  return JSON.stringify(value) ?? typeof value;
};
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const given = value => value !== undefined && value !== null;

/** Whole cents from dollars that are exact to the cent, or null. */
export function exactCents(value, max = MAX_LINE_CENTS) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const cents = moneyCents(value);
  if (cents === null || cents > max) return null;
  return typeof value === 'number' && Math.abs(value * 100 - cents) > 1e-6 ? null : cents;
}

function signed(value, parse) {
  if (typeof value === 'number' && value < 0) { const cents = parse(-value); return cents === null ? null : negative(cents); }
  if (typeof value === 'string' && /^\s*-/.test(value)) { const cents = parse(value.trim().slice(1)); return cents === null ? null : negative(cents); }
  return parse(value);
}

function context(strict) {
  const issues = [];
  return { strict, issues, problem(code, message, where = {}) {
    if (strict) throw fail(code, message, where);
    issues.push({ code: `quote_${code}`, message, ...where });
  } };
}

function text(value, { label, max, required, fallback, problem }) {
  if (value === undefined || value === null || value === '') {
    if (required) problem('invalid_name', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') problem(required ? 'invalid_name' : 'invalid_text', `${label} must be text.`);
  const cleaned = clean(value, 100000);
  if (!cleaned && required) { problem('invalid_name', `${label} is required.`); return fallback; }
  if (cleaned.length > max) problem(required ? 'invalid_name' : 'invalid_text', `${label} must be at most ${max} characters.`);
  return cleaned.slice(0, max);
}

function flag(value, label, problem) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') problem('invalid_flag', `${label} must be true or false.`);
  return value === true;
}

// Returns {group, malformed}. A group whose shape, id, labels, selection mode or
// required flag is invalid is malformed: its line is then read as an optional,
// unselected line (fail closed). Label and zone text repairs are cosmetic.
function normalizeGroup(value, problem) {
  if (!given(value)) return { group: null, malformed: false };
  const malformed = (code, message) => { problem(code, message); return { group: null, malformed: true }; };
  if (!plain(value) || Object.keys(value).some(key => !GROUP_FIELDS.includes(key)) || !safeId(value.id)) return malformed('invalid_group', 'An option group needs a valid id.');
  if (value.label !== undefined && value.name !== undefined && value.label !== value.name) return malformed('invalid_group', 'An option group has two different labels.');
  if (!['single', 'multi'].includes(value.selection)) return malformed('invalid_group', 'An option group must allow a single or multiple selections.');
  if (given(value.required) && typeof value.required !== 'boolean') return malformed('invalid_flag', 'Option group required must be true or false.');
  const label = text(value.label ?? value.name, { label: 'Option group label', max: 120, required: true, fallback: value.id, problem });
  const zone = value.zone === undefined || value.zone === null || value.zone === '' ? null : text(value.zone, { label: 'Option group zone', max: 80, fallback: null, problem });
  return { group: { id: value.id, label, zone, selection: value.selection, required: value.required === true }, malformed: false };
}

function normalizeCatalog(value, problem) {
  if (value === undefined || value === null) return null;
  const version = value?.version;
  if (!plain(value) || Object.keys(value).some(key => !['itemId', 'version'].includes(key)) || !safeId(value.itemId) || !(Number.isSafeInteger(version) && version >= 1 || safeId(version))) {
    problem('invalid_catalog', 'The catalog reference needs an item id and version.');
    return null;
  }
  return { itemId: value.itemId, version };
}

function normalizeSplit(value, { kind, unitCents, customerSupplied, problem }) {
  if (value === undefined || value === null) return null;
  if (['discount', 'tip'].includes(kind)) { problem('split_not_allowed', 'Discount and tip lines cannot carry a cost split.'); return null; }
  if (!plain(value) || Object.keys(value).some(key => !SPLIT_FIELDS.includes(key))) { problem('invalid_split', 'The cost split has unsupported fields.'); return null; }
  const split = {};
  for (const key of SPLIT_FIELDS) {
    const item = value[key] ?? 0;
    if (!Number.isSafeInteger(item) || item < 0 || item > (key === 'laborMinutes' ? 1440 : MAX_LINE_CENTS)) { problem('invalid_split', 'Cost split values must be whole, non-negative cents and minutes.'); return null; }
    split[key] = item;
  }
  if (unitCents !== null && SPLIT_CENTS.reduce((sum, key) => sum + split[key], 0) !== unitCents) { problem('split_mismatch', 'The product, labor, markup and disposal split must add up to the unit price.'); return null; }
  if (customerSupplied && split.productCents > 0) { problem('customer_supplied_product', 'A customer-supplied item cannot charge for the product itself.'); return null; }
  return split;
}

function lineMoney(raw, { kind, quantity, strict, problem }) {
  const whole = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_LINE_CENTS ? value : null;
  const legacyDollars = value => {
    const cents = moneyCents(value);
    if (cents !== null && typeof value === 'number' && Math.abs(value * 100 - cents) > 1e-6) problem('amount_rounded', 'The saved amount was not exact to the cent and was rounded.');
    return cents === null || cents > MAX_LINE_CENTS ? null : cents;
  };
  const amountRaw = raw.amount !== undefined ? raw.amount : raw.total;
  let unit = raw.unitCents === undefined ? undefined : whole(raw.unitCents);
  let total = raw.totalCents === undefined ? undefined : whole(raw.totalCents);
  const dollars = amountRaw === undefined ? undefined : signed(amountRaw, strict ? exactCents : legacyDollars);
  if (unit === null || total === null) problem('invalid_amount', 'Line prices must be whole cents.');
  if (dollars === null) problem('invalid_amount', 'The line amount must be dollars and cents.');
  const isNegative = [unit, total, dollars].some(value => typeof value === 'number' && value < 0);
  if (typeof total === 'number' && typeof dollars === 'number' && Math.abs(total) !== Math.abs(dollars)) problem('amount_mismatch', 'The line amount and totalCents disagree.');
  if (typeof total !== 'number' && typeof dollars === 'number') total = dollars;
  const qh = hundredths(quantity);
  const overCap = () => problem('invalid_amount', 'A line total or unit price cannot exceed $1,000,000.');
  if (typeof unit === 'number') {
    const exact = Math.abs(unit) * qh % 100 === 0, expected = Math.round(Math.abs(unit) * qh / 100);
    if (!exact) problem('fractional_cents', 'Unit price times quantity must come to whole cents.');
    if (expected > MAX_LINE_CENTS) overCap();
    if (typeof total === 'number' && Math.abs(total) !== expected) problem('amount_mismatch', 'The unit price times quantity does not equal the line total.');
    // A derived total over the cap stays unknown rather than being trusted.
    if (typeof total !== 'number') total = expected > MAX_LINE_CENTS ? null : expected;
  } else if (typeof total === 'number') {
    if (Math.abs(total) * 100 % qh === 0) unit = Math.abs(total) * 100 / qh;
    else { problem(strict ? 'unit_price_required' : 'unit_price_rounded', 'The unit price does not divide evenly; provide unitCents.'); unit = Math.round(Math.abs(total) * 100 / qh); }
    if (unit > MAX_LINE_CENTS) { overCap(); unit = null; }
  } else if (unit === undefined && total === undefined && dollars === undefined) problem('amount_required', 'Each line item needs a price.');
  unit = typeof unit === 'number' ? unit : null;
  total = typeof total === 'number' ? total : null;
  if (isNegative && kind !== 'discount') {
    problem('negative_amount', 'Only discount lines can reduce the total.');
    kind = 'discount';
  }
  if (kind === 'discount') return { kind, unitCents: unit === null ? null : negative(unit), totalCents: total === null ? null : negative(total) };
  return { kind, unitCents: unit === null ? null : Math.abs(unit), totalCents: total === null ? null : Math.abs(total) };
}

function normalizeLine(raw, index, ctx, fallbackName) {
  const where = { index }, problem = (code, message) => ctx.problem(code, message, where);
  if (!plain(raw)) { problem('invalid_line_item', 'Each line item must be an object.'); return null; }
  const walkthrough = ['qty', 'total'].some(key => key in raw), estimateShape = ['quantity', 'amount'].some(key => key in raw);
  const legacy = !['kind', 'unitCents', 'totalCents'].some(key => key in raw);
  if (walkthrough && (estimateShape || !legacy)) problem('mixed_shape', 'A line item cannot mix the walkthrough {qty,total} and estimate {quantity,amount} shapes.');
  const unknown = Object.keys(raw).filter(key => !(walkthrough && legacy && !estimateShape ? WALKTHROUGH_FIELDS : FIELDS).includes(key));
  if (ctx.strict && unknown.length) problem('unknown_field', `Unsupported line item field: ${unknown[0]}.`);
  let id = raw.id === undefined && legacy ? `line-${index + 1}` : raw.id;
  if (!safeId(id)) { problem('invalid_id', 'Each line item needs a stable id of letters, numbers, - or _.'); id = `line-${index + 1}`; }
  where.id = id;
  let kind = raw.kind === undefined && legacy ? 'service' : raw.kind;
  if (!LINE_KINDS.includes(kind)) { problem('invalid_kind', `Line item kind must be one of ${LINE_KINDS.join(', ')}.`); kind = 'service'; }
  const name = text(raw.name, { label: 'Line item name', max: 160, required: true, fallback: fallbackName, problem });
  const description = text(raw.description, { label: 'Line item description', max: 600, fallback: '', problem });
  const quantityRaw = raw.quantity !== undefined ? raw.quantity : raw.qty;
  let quantity = quantityRaw === undefined || quantityRaw === null || !ctx.strict && quantityRaw === '' ? 1 : ctx.strict || typeof quantityRaw === 'number' ? quantityRaw : Number(quantityRaw);
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY || Math.abs(quantity * 100 - hundredths(quantity)) > 1e-9) {
    problem('invalid_quantity', 'Quantity must be a positive number with at most two decimals.');
    quantity = 1;
  }
  const money = lineMoney(raw, { kind, quantity, strict: ctx.strict, problem });
  kind = money.kind;
  const optionalMalformed = given(raw.optional) && typeof raw.optional !== 'boolean';
  let optional = flag(raw.optional, 'Optional', problem);
  const { group, malformed: groupMalformed } = normalizeGroup(raw.group, problem);
  let tier = raw.tier === undefined || raw.tier === null ? null : raw.tier;
  if (tier !== null && !TIERS.includes(tier)) { problem('invalid_tier', 'Tier must be good, better or best.'); tier = null; }
  const orphanTier = tier !== null && !group;
  if (orphanTier) problem('tier_requires_group', 'Good, better and best options must belong to an option group.');
  const selectedMalformed = given(raw.selected) && typeof raw.selected !== 'boolean';
  let selected;
  if (groupMalformed || optionalMalformed || orphanTier) {
    // Fail closed: when we cannot tell whether a line is a choice, it is an
    // optional line the customer has not chosen, so it can never add money.
    if (selectedMalformed) problem('invalid_flag', 'Selected must be true or false.');
    optional = true; selected = false;
  } else if (!group && !optional) {
    if (raw.selected === false) problem('required_line_unselected', 'A required line is always included; mark it optional to let the customer decline it.');
    else if (selectedMalformed) problem('invalid_flag', 'Selected must be true or false.');
    if (raw.selected === false || selectedMalformed) { optional = true; selected = false; } else selected = true;
  } else selected = flag(raw.selected, 'Selected', problem);
  const pkg = raw.package === undefined || raw.package === null || raw.package === '' ? null : text(raw.package, { label: 'Package name', max: 80, fallback: null, problem });
  const customerSupplied = flag(raw.customerSupplied, 'Customer supplied', problem);
  const split = normalizeSplit(raw.split, { kind, unitCents: money.unitCents === null ? null : Math.abs(money.unitCents), customerSupplied, problem });
  let durationMinutes = raw.durationMinutes === undefined || raw.durationMinutes === null ? null : raw.durationMinutes;
  if (durationMinutes !== null && !(Number.isSafeInteger(durationMinutes) && durationMinutes >= 0 && durationMinutes <= 1440)) { problem('invalid_duration', 'Duration must be whole minutes per unit (0–1440).'); durationMinutes = null; }
  return { legacy, line: {
    id, kind, name, description, quantity, unitCents: money.unitCents, totalCents: money.totalCents, amount: money.totalCents === null ? null : money.totalCents / 100,
    optional, selected, group, tier, package: pkg, catalog: normalizeCatalog(raw.catalog, problem), customerSupplied, split, durationMinutes, taxable: flag(raw.taxable, 'Taxable', problem),
  } };
}

/** @returns {{lineItems: object[], issues: object[], legacy: boolean}} */
export function normalizeLineItems(items, { strict = false, fallbackName = 'Garage service' } = {}) {
  return normalizeList(items, { strict, fallbackName, limit: MAX_LINE_ITEMS });
}

// `limit` is MAX_LINE_ITEMS for every reader; only the fingerprint reads all lines.
function normalizeList(items, { strict, fallbackName, limit }) {
  const ctx = context(strict);
  if (items === undefined || items === null) return { lineItems: [], issues: [], legacy: false };
  if (!Array.isArray(items)) { ctx.problem('invalid_line_items', 'Line items must be a list.'); return { lineItems: [], issues: ctx.issues, legacy: false }; }
  if (items.length > MAX_LINE_ITEMS) ctx.problem('too_many_lines', `An estimate can hold at most ${MAX_LINE_ITEMS} line items.`);
  const lineItems = [], ids = new Set(), groups = new Map();
  let legacy = false;
  for (const [index, raw] of items.slice(0, limit).entries()) {
    const result = normalizeLine(raw, index, ctx, fallbackName);
    if (!result) continue;
    const { line } = result;
    legacy ||= result.legacy;
    if (ids.has(line.id)) {
      ctx.problem('duplicate_id', 'Line item ids must be unique.', { index, id: line.id });
      let n = 2; while (ids.has(`${line.id.slice(0, 74)}-${n}`)) n++;
      line.id = `${line.id.slice(0, 74)}-${n}`;
    }
    ids.add(line.id);
    if (line.group) {
      const known = groups.get(line.group.id);
      if (!known) groups.set(line.group.id, line.group);
      else if (canonical(known) !== canonical(line.group)) {
        ctx.problem('group_inconsistent', `Every option in ${known.label} must share the same group settings.`, { index, id: line.id, groupId: known.id });
        // Fail closed: an option that disagrees with its group is not a choice.
        Object.assign(line, { group: null, optional: true, selected: false });
      }
      if (line.group) line.group = { ...(known || line.group) };
    }
    lineItems.push(line);
  }
  for (const group of groups.values()) {
    if (group.selection !== 'single') continue;
    const members = lineItems.filter(line => line.group?.id === group.id), chosen = [...new Set(members.filter(line => line.selected).map(choiceKey))];
    if (chosen.length > 1) {
      ctx.problem('group_single_violation', `Choose only one option for ${group.label}.`, { groupId: group.id });
      for (const line of members) if (choiceKey(line) !== chosen[0]) line.selected = false;
    } else if (chosen.length && members.some(line => choiceKey(line) === chosen[0] && !line.selected)) ctx.problem('package_incomplete', `Every line of the chosen ${group.label} package must be selected together.`, { groupId: group.id });
  }
  if (strict) {
    const totals = sumLines(lineItems);
    if (totals.discountCents > totals.subtotalCents) ctx.problem('discount_exceeds_subtotal', 'Discounts cannot exceed the selected services.');
    if (totals.subtotalCents > MAX_TOTAL_CENTS || totals.tipCents > MAX_TOTAL_CENTS) ctx.problem('total_too_large', 'An estimate total cannot exceed $1,000,000.');
  }
  return { lineItems, issues: ctx.issues, legacy };
}

// In a single-select group the choice is a tier (a package may span several
// lines) or, for an untiered line, the line itself.
const choiceKey = line => line.tier ? `tier:${line.tier}` : `line:${line.id}`;

export const included = line => Boolean(line) && (line.group ? line.selected === true : !line.optional || line.selected === true);

// Largest-remainder apportionment keeps every cent: the split parts always add
// up to the line total and never go negative, even for fractional quantities.
function apportion(split, quantity, totalCents) {
  const qh = hundredths(quantity), parts = SPLIT_CENTS.map(key => ({ key, whole: Math.floor(split[key] * qh / 100), rest: split[key] * qh % 100 }));
  let residual = totalCents - parts.reduce((sum, part) => sum + part.whole, 0);
  if (residual < 0 || residual > parts.length) return null;
  for (const part of [...parts].sort((a, b) => b.rest - a.rest)) if (residual > 0) { part.whole++; residual--; }
  return Object.fromEntries(parts.map(part => [part.key, part.whole]));
}

function lineBreakdown(line) {
  const out = { productCents: 0, laborCents: 0, disposalCents: 0, markupCents: 0, otherCents: 0 };
  if (line.totalCents === null) return Object.fromEntries(Object.keys(out).map(key => [key, null]));
  const parts = line.split && apportion(line.split, line.quantity, line.totalCents);
  if (parts) return { ...out, ...parts };
  const key = line.kind === 'product' ? (line.customerSupplied ? 'laborCents' : 'productCents') : line.kind === 'labor' ? 'laborCents' : line.kind === 'disposal' ? 'disposalCents' : 'otherCents';
  return { ...out, [key]: line.totalCents };
}

function sumLines(lineItems) {
  const totals = { lineCount: lineItems.length, includedCount: 0, requiredCents: 0, selectedCents: 0, optionalAvailableCents: 0, subtotalCents: 0, discountCents: 0, totalCents: 0, tipCents: 0, productCents: 0, laborCents: 0, disposalCents: 0, markupCents: 0, otherCents: 0, taxableCents: 0, laborMinutes: 0 };
  const add = (key, cents) => { totals[key] = totals[key] === null || cents === null ? null : totals[key] + cents; };
  for (const line of lineItems) {
    if (!included(line)) {
      if (!['discount', 'tip'].includes(line.kind) && line.group?.selection !== 'single') add('optionalAvailableCents', line.totalCents);
      continue;
    }
    totals.includedCount++;
    if (line.kind === 'tip') { add('tipCents', line.totalCents); continue; }
    if (line.taxable) add('taxableCents', line.totalCents);
    if (line.kind === 'discount') { add('discountCents', line.totalCents === null ? null : -line.totalCents); continue; }
    add('subtotalCents', line.totalCents);
    add(line.optional || line.group ? 'selectedCents' : 'requiredCents', line.totalCents);
    for (const [key, cents] of Object.entries(lineBreakdown(line))) add(key, cents);
    if (line.split?.laborMinutes) totals.laborMinutes += Math.ceil(line.split.laborMinutes * hundredths(line.quantity) / 100);
  }
  totals.totalCents = totals.subtotalCents === null || totals.discountCents === null ? null : Math.max(0, totals.subtotalCents - totals.discountCents);
  if (totals.taxableCents !== null) totals.taxableCents = Math.max(0, totals.taxableCents);
  return totals;
}

/**
 * Totals over INCLUDED lines only. subtotal = required + selected charges;
 * discountCents is the positive size of included discounts; totalCents never
 * goes below zero. optionalAvailableCents is what unselected optional lines and
 * multi-select add-ons would add (single-select alternatives are reported by
 * packageTotals instead). product+labor+disposal+markup+other = subtotal; a
 * line without a split is attributed by its kind (service/fee -> other, a
 * customer-supplied product -> labor). Any unknown included price makes the
 * affected totals null and complete=false. complete is also false when any
 * repair could change what is charged or included (only text, id, catalog and
 * duration repairs leave it true). A subtotal or tip total above
 * MAX_TOTAL_CENTS is out of range: totalCents is then null.
 */
export function estimateTotals(items) {
  const { lineItems, issues } = normalizeLineItems(items);
  const totals = sumLines(lineItems), found = [...issues];
  if (totals.discountCents !== null && totals.subtotalCents !== null && totals.discountCents > totals.subtotalCents) found.push({ code: 'quote_discount_exceeds_subtotal', message: 'Discounts exceed the selected services; the total is held at zero.' });
  if (totals.subtotalCents > MAX_TOTAL_CENTS || totals.tipCents > MAX_TOTAL_CENTS) {
    found.push({ code: 'quote_total_too_large', message: 'The estimate total is above $1,000,000 and is treated as unknown.' });
    totals.totalCents = null;
  }
  const complete = Object.values(totals).every(value => value !== null) && found.every(issue => COSMETIC_ISSUES.has(issue.code));
  return { ...totals, complete, issues: found };
}

export const selectedTotalCents = items => estimateTotals(items).totalCents;

/** Deposit in whole cents; half cents round up (1000.01 at 50% -> 500.01). */
export function depositCents(totalCents, pct = 50) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || totalCents > MAX_TOTAL_CENTS) throw fail('invalid_amount', 'The deposit needs a whole-cent total.');
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || Math.abs(pct * 100 - Math.round(pct * 100)) > 1e-9) throw fail('invalid_deposit_percent', 'The deposit percent must be between 0 and 100.');
  return Math.round(totalCents * Math.round(pct * 100) / 10000);
}

/**
 * Option groups in first-appearance order, with their item ids, selected ids
 * and item tiers. With {includeUngrouped:true} one more entry closes the list:
 * {id:null, ungrouped:true, selection:'multi', itemIds: the ungrouped optional
 * lines, fixedIds: the required lines}. That full form carries everything
 * validateSelection needs, so validating it (also after a JSON round trip)
 * gives exactly the result of validating the lines themselves. The default
 * form lists option groups only; validating it checks group choices and
 * reports any other id as quote_selection_unknown.
 */
export function lineItemGroups(items, { includeUngrouped = false } = {}) {
  const groups = new Map(), lines = normalizeLineItems(items).lineItems;
  for (const line of lines) {
    if (!line.group) continue;
    const entry = groups.get(line.group.id) || { ...line.group, itemIds: [], selectedIds: [], itemTiers: {} };
    entry.itemIds.push(line.id);
    entry.itemTiers[line.id] = line.tier;
    if (line.selected) entry.selectedIds.push(line.id);
    groups.set(line.group.id, entry);
  }
  const result = [...groups.values()];
  if (includeUngrouped) {
    const optional = lines.filter(line => !line.group && line.optional);
    result.push({ id: null, ungrouped: true, label: 'Optional items', zone: null, selection: 'multi', required: false, itemIds: optional.map(line => line.id), selectedIds: optional.filter(line => line.selected).map(line => line.id), itemTiers: Object.fromEntries(optional.map(line => [line.id, null])), fixedIds: lines.filter(line => !line.group && !line.optional).map(line => line.id) });
  }
  return result;
}

const ids = value => Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];

/**
 * Checks a customer's choice. `source` is line items or lineItemGroups()
 * output; line items are validated through lineItemGroups(items,
 * {includeUngrouped:true}), so both forms share one code path. `selectedIds`
 * defaults to the currently selected options. A single-select group allows one
 * choice (one tier with all of its lines, or one untiered line) and a required
 * group needs one; naming a required line is harmless. Returns {ok, issues[]}
 * with quote_* codes; it never throws.
 */
export function validateSelection(source, selectedIds) {
  const groupsGiven = Array.isArray(source) && source.length > 0 && source.every(group => plain(group) && Array.isArray(group.itemIds));
  const groups = groupsGiven ? source : lineItemGroups(source, { includeUngrouped: true });
  const choosable = new Set(groups.flatMap(group => ids(group.itemIds))), fixed = new Set(groups.flatMap(group => ids(group.fixedIds)));
  const chosenIds = selectedIds === undefined ? groups.flatMap(group => ids(group.selectedIds)) : selectedIds;
  if (!Array.isArray(chosenIds)) return { ok: false, issues: [{ code: 'quote_invalid_selection', message: 'The selection must be a list of option ids.' }] };
  const issues = [], seen = new Set();
  for (const id of chosenIds) {
    if (typeof id !== 'string') { issues.push({ code: 'quote_invalid_selection', message: 'The selection must be a list of option ids.' }); continue; }
    if (seen.has(id)) { issues.push({ code: 'quote_selection_duplicate', itemId: id, message: 'An option was selected twice.' }); continue; }
    seen.add(id);
    if (!choosable.has(id) && !fixed.has(id)) issues.push({ code: 'quote_selection_unknown', itemId: id, message: 'That option is not part of this estimate.' });
  }
  for (const group of groups) {
    if (group.ungrouped) continue;
    const key = id => choiceKey({ id, tier: group.itemTiers?.[id] || null }), chosen = [...new Set(ids(group.itemIds).filter(id => seen.has(id)).map(key))];
    if (group.selection === 'single' && chosen.length > 1) issues.push({ code: 'quote_group_single_violation', groupId: group.id, message: `Choose only one option for ${group.label}.` });
    else if (group.selection === 'single' && chosen.length === 1 && ids(group.itemIds).some(id => key(id) === chosen[0] && !seen.has(id))) issues.push({ code: 'quote_package_incomplete', groupId: group.id, message: `Choose the whole ${group.label} package.` });
    if (group.required && chosen.length === 0) issues.push({ code: 'quote_group_choice_required', groupId: group.id, message: `Choose an option for ${group.label}.` });
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Applies a validated customer choice; throws the first quote_* problem. The
 * chosen estimate is validated strictly again, so a choice can never produce a
 * total above MAX_TOTAL_CENTS or discounts above the chosen services.
 */
export function applySelection(items, selectedIds) {
  const { lineItems } = normalizeLineItems(items, { strict: true }), result = validateSelection(lineItems, selectedIds);
  if (!result.ok) throw Object.assign(new Error(result.issues[0].message), { code: result.issues[0].code, status: 400, details: { issues: result.issues } });
  const chosen = new Set(selectedIds);
  return normalizeLineItems(lineItems.map(line => line.group || line.optional ? { ...line, selected: chosen.has(line.id) } : line), { strict: true }).lineItems;
}

/** Good/better/best totals per option group (tips excluded, discounts net). */
export function packageTotals(items) {
  const groups = new Map(), sum = (current, cents) => current === undefined ? cents : current === null || cents === null ? null : current + cents;
  for (const line of normalizeLineItems(items).lineItems) {
    if (!line.group || line.kind === 'tip') continue;
    const entry = groups.get(line.group.id) || { group: line.group, tiers: {}, packages: {}, untiered: undefined, selected: 0, selectedTiers: new Set() };
    if (line.tier) { entry.tiers[line.tier] = sum(entry.tiers[line.tier], line.totalCents); entry.packages[line.tier] ||= line.package; }
    else entry.untiered = sum(entry.untiered, line.totalCents);
    if (line.selected) { entry.selected = sum(entry.selected, line.totalCents); if (line.tier) entry.selectedTiers.add(line.tier); }
    groups.set(line.group.id, entry);
  }
  return [...groups.values()].map(({ group, tiers, packages, untiered, selected, selectedTiers }) => ({
    groupId: group.id, label: group.label, zone: group.zone, selection: group.selection, required: group.required,
    tiers: Object.fromEntries(TIERS.map(tier => [tier, tiers[tier] ?? null])), packages: Object.fromEntries(TIERS.map(tier => [tier, packages[tier] || null])),
    untieredCents: untiered ?? null, selectedCents: selected, selectedTier: selectedTiers.size === 1 ? [...selectedTiers][0] : null,
  }));
}

/**
 * The quoted amount chain customerMoneyState reads, parsed strictly. null means
 * unknown: missing, not dollars and cents, or above MAX_TOTAL_CENTS.
 */
export function quotedAmountCents(job) {
  const value = job?.estimate?.amount ?? job?.total ?? job?.priceQuoted ?? job?.lockedTotal ?? job?.rate ?? job?.customerApproval?.amount;
  const cents = value === undefined || value === null ? null : moneyCents(value);
  return cents === null || cents > MAX_TOTAL_CENTS ? null : cents;
}

// Fallback naming per surface for a job without saved lines.
//   portal:   the customer portal DTO (serviceType || type || 'Garage service').
//   document: the printed estimate/invoice (opsPrintDocument).
//   invoice:  the Hub "Issue invoice" record (serviceType || 'Garage transformation').
const SURFACES = {
  portal: { name: job => job?.serviceType || job?.type || 'Garage service', description: (job, source) => job?.estimate?.scope || job?.scopeSummary || '', fallbackName: () => 'Garage service' },
  document: { name: job => job?.serviceType || 'Garage transformation', description: (job, source) => source.scope || job?.scopeSummary || 'Bundled flat-rate garage service', fallbackName: job => job?.serviceType || 'Garage service' },
  invoice: { name: job => job?.serviceType || 'Garage transformation', description: job => job?.estimate?.scope || job?.scopeSummary || '', fallbackName: job => job?.serviceType || 'Garage transformation' },
};
const surfaceOf = surface => SURFACES[surface] || SURFACES.portal;

/**
 * One required line for a legacy single-price estimate or invoice (read
 * adapter; nothing is backfilled). surface 'portal' matches the customer
 * portal fallback, 'document' the printed estimate/invoice fallback and
 * 'invoice' the Hub "Issue invoice" record.
 */
export function singleLineItem(job, { record = 'estimate', surface = 'portal', totalCents = quotedAmountCents(job) } = {}) {
  const source = plain(job?.[record]) ? job[record] : {}, naming = surfaceOf(surface);
  const cents = Number.isSafeInteger(totalCents) && totalCents >= 0 && totalCents <= MAX_LINE_CENTS ? totalCents : null;
  return { id: 'legacy-1', kind: 'service', name: clean(naming.name(job), 160), description: clean(naming.description(job, source), 600), quantity: 1, unitCents: cents, totalCents: cents, amount: cents === null ? null : cents / 100, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, split: null, durationMinutes: null, taxable: false };
}

/** Read adapter for any saved job: its record lines, or one synthesized required line. */
export function legacyLineItems(job, { record = 'estimate', surface = 'portal', totalCents } = {}) {
  const lines = job?.[record]?.lineItems;
  if (Array.isArray(lines) && lines.length) return { ...normalizeLineItems(lines, { fallbackName: surfaceOf(surface).fallbackName(job) }), source: 'record' };
  const line = singleLineItem(job, { record, surface, ...(totalCents === undefined ? {} : { totalCents }) });
  return { lineItems: [line], issues: line.totalCents === null ? [{ code: 'quote_invalid_amount', message: 'The saved quote amount is missing or invalid.', index: 0, id: line.id }] : [], legacy: true, source: 'synthesized' };
}

/** Today's stored/displayed estimate line shape. */
export const toLegacyLineItem = line => ({ name: line.name, description: line.description, quantity: line.quantity, amount: line.amount });
/** The walkthrough/provider (snake-case game_plan) line shape. */
export const toWalkthroughLineItem = line => ({ name: line.name, qty: line.quantity, total: line.amount });
/**
 * Customer-facing projection of a canonical line: CUSTOMER_LINE_FIELDS only.
 * Cost splits (markup), catalog references, durations, groups and packages
 * never reach an invoice or any other customer document.
 */
export const customerLineItem = line => Object.fromEntries(CUSTOMER_LINE_FIELDS.map(key => [key, line?.[key] ?? null]));

/**
 * sha256 over what the customer sees and agrees to, so ANY stored change is
 * detected:
 *   - the canonical view of every line (no MAX_LINE_ITEMS cut), with an
 *     optional estimate.selectedIds applied, which gives selection semantics;
 *   - the raw stored lines exactly as saved (all of them, untruncated and
 *     unrepaired, keys sorted), so a change hidden by a lenient repair (a price
 *     on line 101, text past a length cap, an invalid quantity or amount)
 *     still changes the fingerprint;
 *   - the saved amount and deposit in cents and the raw scope.
 * Only the internal fields split, catalog and durationMinutes are left out.
 */
export function estimateFingerprint(estimate) {
  const source = plain(estimate) ? estimate : {};
  let { lineItems } = normalizeList(source.lineItems, { strict: false, fallbackName: 'Garage service', limit: Infinity });
  if (Array.isArray(source.selectedIds)) {
    const chosen = new Set(source.selectedIds);
    lineItems = lineItems.map(line => line.group || line.optional ? { ...line, selected: chosen.has(line.id) } : line);
  }
  const stored = Array.isArray(source.lineItems) ? source.lineItems.map(line => plain(line) ? Object.fromEntries(Object.entries(line).filter(([key]) => !INTERNAL_FIELDS.has(key))) : line) : source.lineItems;
  const money = value => value === undefined || value === null ? null : moneyCents(value) ?? `invalid:${exactCanonical(value)}`;
  const body = { v: 2, lines: lineItems.map(line => Object.fromEntries(MATERIAL.map(key => [key, line[key]]))), stored, amountCents: money(source.amount), depositCents: money(source.depositRequired), scope: source.scope };
  return hex(sha256(new TextEncoder().encode(exactCanonical(body))));
}

export const estimateChanged = (previous, next) => estimateFingerprint(previous) !== estimateFingerprint(next);
