import { catalogLinePricer, staleItems } from './catalog.js';
import { depositCents, estimateTotals, normalizeLineItems } from './quote-model.js';

// Catalog product quotes are priced from the current, released server snapshot.
// The public preview omits the internal product/labor cost split; the saved Hub
// estimate retains it for job costing. Legacy walkthrough quotes use their own
// price table and never pass through this path.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: `quote_draft_catalog_${code}`, status });
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const LINE_ID = /^catalog-[1-9][0-9]*$/;

export function priceCatalogQuote(state, descriptor, now = new Date()) {
  if (!keys(descriptor, ['catalogVersion', 'settingsVersion', 'items']) ||
      typeof descriptor.catalogVersion !== 'string' || typeof descriptor.settingsVersion !== 'string' ||
      !Array.isArray(descriptor.items) || descriptor.items.length < 1 || descriptor.items.length > 12) {
    throw fail('invalid_selection', 'Choose 1 to 12 catalog products and preview the quote again.', 400);
  }
  const { catalog, publication, settings } = state || {};
  if (!catalog || !publication || !settings) throw fail('unavailable', 'The catalog prices could not be verified. Keep the quote and retry.', 503);
  if (settings.mustSetBeforeCustomerUse !== false) throw fail('not_released', 'Catalog pricing has not been released for customer quotes.', 409);
  if (descriptor.catalogVersion !== publication.version || descriptor.settingsVersion !== settings.settingsVersion) {
    throw fail('version_changed', 'Catalog prices changed. Preview the current products and prices before saving.', 409);
  }
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw fail('unavailable', 'The catalog date could not be verified. Retry.', 503);
  const stale = new Set(staleItems(catalog, at).map(item => item.id));
  const byId = new Map(catalog.items.map(item => [item.id, item]));
  const seen = new Set(), lineIds = new Set(), priceLine = catalogLinePricer(settings);
  const lines = descriptor.items.map(selection => {
    if (!keys(selection, ['id', 'itemId', 'quantity', 'customerSupplied']) ||
        typeof selection.id !== 'string' || selection.id.length > 80 || !LINE_ID.test(selection.id) || lineIds.has(selection.id) || !ID.test(selection.itemId) ||
        !Number.isSafeInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 10000 ||
        typeof selection.customerSupplied !== 'boolean' || seen.has(`${selection.itemId}:${selection.customerSupplied}`)) {
      throw fail('invalid_selection', 'Catalog selections need distinct line IDs and supply choices with whole quantities.', 400);
    }
    seen.add(`${selection.itemId}:${selection.customerSupplied}`); lineIds.add(selection.id);
    const item = byId.get(selection.itemId);
    if (!item || item.kind !== 'product' || item.availability !== 'active') throw fail('item_unavailable', 'One selected product is no longer available for an EGC quote. Review the catalog.', 409);
    if (item.priceVerified !== true || stale.has(item.id)) throw fail('price_unverified', `${item.name} needs a current verified price before a customer quote.`, 409);
    let priced;
    try { priced = priceLine(item, { quantity: selection.quantity, customerSupplied: selection.customerSupplied }); }
    catch (error) {
      if (error?.code === 'catalog_pricing_invalid') throw fail('invalid_selection', 'This quantity would exceed the quote line limit. Lower it and preview again.', 400);
      throw error;
    }
    return { id: selection.id, ...priced, description: selection.customerSupplied ? 'Customer supplies the product; EGC installs it.' : 'EGC supplies and installs this product.',
      amount: priced.totalCents / 100, optional: false, selected: true, taxable: false,
      catalog: { itemId: item.id, version: publication.version } };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 100000000) throw fail('amount_too_large', 'The selected products exceed the $1,000,000 quote limit.', 400);
  const minimumAdjustmentCents = Math.max(0, settings.minimumJobCents - subtotalCents);
  if (minimumAdjustmentCents) {
    if (lines.length >= 12) throw fail('too_many_lines', 'The minimum charge needs its own visible line. Choose at most 11 products for this quote.', 400);
    lines.push({ id: 'catalog-minimum', kind: 'fee', name: 'Minimum job charge', description: 'Brings this quote to the minimum job charge.', quantity: 1,
      unitCents: minimumAdjustmentCents, totalCents: minimumAdjustmentCents, amount: minimumAdjustmentCents / 100,
      optional: false, selected: true, taxable: false, customerSupplied: false });
  }
  const storedLineItems = normalizeLineItems(lines, { strict: true }).lineItems;
  const totals = estimateTotals(storedLineItems);
  if (!totals.complete || !Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0 || totals.totalCents !== subtotalCents + minimumAdjustmentCents) {
    throw fail('unavailable', 'The catalog quote total could not be verified. Keep the selections and retry.', 503);
  }
  const lineItems = storedLineItems.map(({ split, durationMinutes, ...line }) => line);
  return { catalogPricing: descriptor, lineItems, storedLineItems, subtotalCents, minimumAdjustmentCents,
    totalCents: totals.totalCents, depositCents: depositCents(totals.totalCents, settings.depositPct),
    depositPct: settings.depositPct, settingsVersion: settings.settingsVersion, catalogVersion: publication.version };
}
