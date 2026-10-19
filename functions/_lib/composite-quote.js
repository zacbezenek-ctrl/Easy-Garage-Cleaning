import { goodsMarkupOf, roundCents, validatePricingSettings } from './catalog.js';
import { BUILDER_LABOR_VERSION, HAULING_GROUPS, LABOR_INSTALL_NOTE, LABOR_LINE_NAME, builderJunkOnly, estimateTotals, included, normalizeLineItems } from './quote-model.js';
import { PRICING_MENU_JSON } from '../_data/pricing-menu.js';

/**
 * Guided estimator quote builder (WP14a/b). Pure: no I/O, no clock (the bundled menu is parsed lazily, once).
 *
 * A composite quote is always built in one order: (1) Removal / cleanout (garage cleaning base, junk loads,
 * special-handling items, access, cleaning add-ons), (2) Shelving, (3) Extra storage. Each step is a section of
 * the quote with its own subtotal and a running total. The browser only describes the selection
 * (compositePricing); every price is computed here from the server's pricing state:
 *   menu       functions/_data/pricing-menu.json (scripts/import-pricing-menu.mjs): public-retail goods per pack
 *              and the service/junk items of the owner's pricing menu. Every product is a DRAFT.
 *   settings   the pricing settings in force (catalog-store.js); goodsMarkup turns the goods cost basis
 *              (retailPerPackCents) into the selling price per pack, rounded by settings.roundingRule.
 *   walkthrough the walkthrough price tables (pricing-config.js walkthroughPricing()), the DRAFT amounts of
 *              cleaning bases, cleaning add-ons, special items and access until the owner approves a price.
 *   approvals  pricingMenuApprovals/current: {items: {[menuItemId]: {unitCents, identity}}, revision,
 *              goodsInstallationIncluded?}, written only by the owner's bulk approval (catalog-store.js menu.approve).
 * A price is approved when the menu itself records an owner-approved amount (the $750 full truck) or the owner
 * approved that item at exactly that amount. An owner-approved service amount is the price; a product approval
 * holds only while cost x goodsMarkup still gives the approved amount. An approval also names the item it was
 * given for (menuItemIdentity): a re-import that renames or re-maps an item id puts it back into draft. Draft prices may
 * be saved on an unsent draft, never sent: quote-draft.js re-checks compositeApproval() at send preview and send.
 *
 * Labor (owner decision D12, 2026-10-18: "We have to price man hours estimated to do the job. It's $40 an hour."; the
 * owner's decision of 2026-10-19 set the rate to $53.00 per man-hour):
 * every builder quote with garage work also carries one Labor line, man-hours x the labor rate, on top of the menu lines.
 * The rate is the owner's own decision, so it is an approved price: approvals.laborRatePerManHourCents (the owner's
 * menu.approve on Menu prices) else DEFAULT_LABOR_RATE_CENTS ($53.00). It is never read from the browser. The man-hours
 * are the estimator's (compositePricing.labor.manHours), pre-filled from the server's own time estimate of the selection
 * itself (laborEstimate: person-minutes of the garage work and of installing the goods, never divided by a crew, rounded
 * or capped to a working day) and adjustable; the quote records the estimate, whether the estimator adjusted the man-hours
 * and whether they are below the estimate (belowEstimate, for the owner). Shelving and storage installation is billed
 * through this line. Goods are priced without installation, so goods the time estimate has no install time for
 * (installNotEstimated), and every quote saved before the Labor line existed (a breakdown without labor), wait for the
 * owner to confirm that installation is included in the goods price: in the pricing settings (goodsInstallationIncluded,
 * only while CATALOG_QUOTES_ENABLED is on) or with the menu approvals (approvals.goodsInstallationIncluded). A quote with
 * a Labor line also passes once the estimator set the man-hours by hand (labor.adjusted) after being told which goods
 * the estimate leaves out.
 *
 * Junk removal (owner decision D-JUNK, 2026-10-18: "$750 per truck covers the crew's time"): the truck-load prices (the
 * $750 full truck and the partial loads drafted from it) already pay for loading, hauling and disposal, and so do the
 * special-handling items ("incremental disposal/handling") and access charges ("incremental labor only") that go with
 * them (HAULING_GROUPS). So (1) the labor estimate never counts truck-load, hauling or disposal time: of the walkthrough
 * time model it keeps the set-up and sweep-out (base), the sorting of the garage's contents (the fullness minutes, with a
 * garage cleaning base), the cleaning add-ons and the install time of the goods, and drops the per-load minutes, the
 * special-item minutes and the access minutes (laborTime); (2) a junk-only quote (junkOnly: at least one truck load, and
 * otherwise only special-handling items and access charges; no cleaning base, cleaning add-on, shelving or storage) has
 * no Labor line at all and is complete, sendable and signable without one: it is $750 per truck. Special items and
 * access charges are priced on top of a truck already on the job, so a quote of only those (no truck load) is not
 * junk-only: nothing else would pay the crew's time, and it keeps its Labor line. Every quote with garage work (sorting
 * and organizing, shelving, storage, installation, cleaning) still needs its Labor line.
 *
 * What the customer sees (owner decision D-LABOR-TEXT, 2026-10-18): the Labor line is one amount, "Labor" (and, with
 * goods, "Includes installing the shelving and storage."), never the man-hours, the rate or an hourly wording; the
 * man-hours are kept for the staff (breakdown.labor). LABOR_VERSION marks a Labor line priced by these rules: an unsent
 * quote saved earlier (its line read "Labor: N man-hours × $R" and its estimate counted the truck loads), and an unsent
 * junk-only quote that still has a Labor line, are saved again before they are sent; a signed job keeps what was signed.
 *
 * The customer-facing estimate keeps at most 12 charged lines (the portal limit): special-handling items, access
 * charges and each goods step (shelving, extra storage) roll up into one line each, and labor is one line; the
 * breakdown keeps every item.
 *
 * Money is integer cents. Error codes are quote_draft_composite_* (the quote-draft API passes them through).
 */

export const COMPOSITE_SCHEMA_VERSION = 1;
export const BUILDER_STEPS = Object.freeze(['removal', 'shelving', 'storage']);
export const LINE_CATEGORIES = Object.freeze(['removal', 'shelving', 'storage', 'service']);
export const BUILDER_SECTIONS = Object.freeze([
  { id: 'removal', label: 'Removal / cleanout', groups: [
    { id: 'cleaning-base', label: 'Garage cleaning base' }, { id: 'junk', label: 'Junk removal' }, { id: 'special', label: 'Special-handling items' },
    { id: 'access', label: 'Access' }, { id: 'cleaning', label: 'Cleaning add-ons' }] },
  { id: 'shelving', label: 'Shelving', groups: [{ id: 'shelving', label: 'Shelving' }] },
  { id: 'storage', label: 'Extra storage', groups: [
    { id: 'overhead', label: 'Overhead storage' }, { id: 'hooks-racks', label: 'Hooks & racks' }, { id: 'track-systems', label: 'Track systems' },
    { id: 'bins-totes', label: 'Bins & totes' }, { id: 'cabinets-workbenches', label: 'Cabinets & workbenches' }, { id: 'bike-storage', label: 'Bike storage' },
    { id: 'small-parts', label: 'Small-parts organizers' }, { id: 'pegboards', label: 'Pegboards' }] },
].map(section => Object.freeze({ ...section, groups: Object.freeze(section.groups.map(group => Object.freeze(group))) })));
const GROUPS = new Map(BUILDER_SECTIONS.flatMap(section => section.groups.map(group => [group.id, section.id])));
const SECTION_LABEL = new Map(BUILDER_SECTIONS.map(section => [section.id, section.label]));
const GROUP_LABEL = new Map(BUILDER_SECTIONS.flatMap(section => section.groups.map(group => [group.id, group.label])));
const REMOVAL_GROUP_ORDER = BUILDER_SECTIONS[0].groups.map(group => group.id);
export const MENU_UNITS = Object.freeze(['job', 'load', 'item', 'bundle']);
export const JUNK_FRACTIONS = Object.freeze([0.25, 0.5, 0.75, 1]);
const WALKTHROUGH_TABLES = ['sizeBase', 'services', 'deep_clean', 'hazards', 'special', 'access'];
export const GARAGE_SIZES = Object.freeze(['1', '2', '3', 'other']);
// The customer portal and quote drafts charge at most 12 lines (money-service MAX_ESTIMATE_LINES, quote-draft
// MAX_INCLUDED_LINES); special-handling items, access charges and each goods step roll up into one line each, so
// the largest removal step (9 lines) plus both goods lines and the Labor line always fits.
export const MAX_CHARGED_LINES = 12;
// D12: the Labor line. Its id is the customer-facing line id; the rate is the owner's (laborRate), $53.00 by default.
export const LABOR_ID = 'labor';
// The Labor rules a priced labor records (breakdown.labor.version): 2 is D-JUNK and D-LABOR-TEXT (no hauling in the
// estimate, no Labor line on a junk-only quote, one amount for the customer). Labor priced before (no version) is 1.
// (quote-model.js BUILDER_LABOR_VERSION, which the customer surfaces read too.)
export const LABOR_VERSION = BUILDER_LABOR_VERSION;
// D-JUNK: the removal groups whose own prices pay the crew's time (truck loads; special-handling items and access charges,
// which go with them). A quote of at least one truck load and nothing else is junk-only (junkOnly): no Labor line, $750
// per truck.
export { HAULING_GROUPS };
/** A junk-only quote (D-JUNK; quote-model.js builderJunkOnly): its builder lines (breakdown lines, or anything with section
 * and group) are all truck loads, special-handling items or access charges, and at least one is a truck load (group
 * 'junk'): the special items' "incremental disposal/handling" and the access charges' "incremental labor only" assume a
 * truck on the job. A quote with a cleaning base, a cleaning add-on, shelving or storage is not, and neither is one of
 * special items or access alone (it keeps its Labor line). */
export const junkOnly = builderJunkOnly;
export const DEFAULT_LABOR_RATE_CENTS = 5300;
export const LABOR_RATE_LIMITS = Object.freeze({ min: 100, max: 100000 });
export const LABOR_MAN_HOURS = Object.freeze({ min: 0.5, max: 200, step: 0.25 });
// The browser's labor selection: the man-hours (null: the estimate), whether the estimator set them by hand, and the
// walkthrough's garage fullness (crew/gameplan.html "How full is it?"), the one input of the time estimate the builder
// selection does not hold. The signed handoff replaces the fullness with the signed plan's own (scope.fullness).
const LABOR_KEYS = ['manHours', 'adjusted', 'fullness'];
export const FULLNESS = Object.freeze(['light', 'medium', 'full', 'packed']);
/** A walkthrough fullness ('Medium', 'packed', ...) as the time model's key, else null (unknown: the model's default). */
export const fullnessOf = value => typeof value === 'string' && FULLNESS.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
const LABOR_DEFAULT_REASON = 'Owner decision (2026-10-19): $53.00 per man-hour.';
// The rolled-up goods line of each goods step. Its catalog reference names the step (compositeCatalogCategory).
export const GOODS_LINES = Object.freeze({
  shelving: Object.freeze({ id: 'shelving-goods', catalogId: 'menu-shelving', name: 'Shelving' }),
  storage: Object.freeze({ id: 'storage-goods', catalogId: 'menu-storage', name: 'Extra storage' }),
});
export const INSTALLATION_ID = 'goods-installation';
const MAX_ITEM_CENTS = 10000000, MAX_TOTAL_CENTS = 100000000, MAX_PACKS = 999, MAX_SPECIAL = 99, MAX_FULL_LOADS = 20, MAX_SELECTIONS = 60;
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCT_ID = /^hd-\d{6,12}$/, SERVICE_ID = /^egc-\d{3}$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `quote_draft_composite_${code}`, status, ...(details ? { details } : {}) });
const menuInvalid = (path, reason) => Object.assign(new Error(`Pricing menu is invalid at ${path}: ${reason}`), { code: 'composite_menu_invalid', status: 400, details: { path, reason } });
const money = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const keysOnly = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

function text(value, path, { max = 600, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\r\n\t]/.test(value)) throw menuInvalid(path, `must be ${nullable ? 'null or ' : ''}trimmed one-line text of at most ${max} characters`);
  return value;
}
function count(value, path, min, max, nullable = false) {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw menuInvalid(path, `must be ${nullable ? 'null or ' : ''}a whole number from ${min} to ${max}`);
  return value;
}
function httpsUrl(value, path, hosts, nullable = false) {
  if (value === null && nullable) return null;
  let url;
  try { url = new URL(text(value, path, { max: 600 })); } catch (error) { if (error.code === 'composite_menu_invalid') throw error; throw menuInvalid(path, 'must be a URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw menuInvalid(path, `must be a public https URL on ${hosts.join(' or ')}`);
  return value;
}
function shape(value, path, required, optional = []) {
  if (!plain(value)) throw menuInvalid(path, 'must be an object');
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw menuInvalid(`${path}.${key}`, 'is not an allowed field');
  for (const key of required) if (!Object.hasOwn(value, key)) throw menuInvalid(`${path}.${key}`, 'is required');
}

const PRODUCT_KEYS = ['id', 'sku', 'retailer', 'name', 'section', 'group', 'unitsPerPack', 'retailPerPackCents', 'perOrderPackLimit', 'productUrl', 'photoUrl', 'fitWarnings', 'evidence', 'status'];
const SERVICE_KEYS = ['id', 'menuId', 'section', 'category', 'group', 'name', 'unit', 'basis', 'status'];
const MENU_KEYS = ['schemaVersion', 'menuVersion', 'generatedOn', 'currency', 'status', 'source', 'priceBasis', 'products', 'services'];

/** Validates the pricing menu document (functions/_data/pricing-menu.json). Products are always draft: only the
 * owner approves a goods price, at runtime. Only a service may carry an owner-approved amount in the data. */
export function validatePricingMenu(menu) {
  shape(menu, 'menu', MENU_KEYS);
  if (menu.schemaVersion !== COMPOSITE_SCHEMA_VERSION) throw menuInvalid('menu.schemaVersion', `must be ${COMPOSITE_SCHEMA_VERSION}`);
  if (typeof menu.menuVersion !== 'string' || !VERSION.test(menu.menuVersion)) throw menuInvalid('menu.menuVersion', 'must look like YYYY-MM-DD.N');
  if (typeof menu.generatedOn !== 'string' || !DATE.test(menu.generatedOn) || menu.menuVersion.slice(0, 10) !== menu.generatedOn) throw menuInvalid('menu.generatedOn', 'must be the date in menuVersion');
  if (menu.currency !== 'USD') throw menuInvalid('menu.currency', 'must be USD');
  if (menu.status !== 'draft') throw menuInvalid('menu.status', 'must be draft: an imported menu is never approved as a whole');
  text(menu.source, 'menu.source', { max: 600 }); text(menu.priceBasis, 'menu.priceBasis', { max: 1200 });
  if (!Array.isArray(menu.products) || menu.products.length < 1 || menu.products.length > 1000) throw menuInvalid('menu.products', 'must list 1 to 1000 products');
  if (!Array.isArray(menu.services) || menu.services.length < 1 || menu.services.length > 200) throw menuInvalid('menu.services', 'must list 1 to 200 services');
  const ids = new Set(), skus = new Set();
  menu.products.forEach((product, index) => {
    const at = `menu.products[${index}]`;
    shape(product, at, PRODUCT_KEYS);
    if (typeof product.sku !== 'string' || !/^\d{6,12}$/.test(product.sku)) throw menuInvalid(`${at}.sku`, 'must be the retailer internet SKU (6 to 12 digits)');
    if (product.id !== `hd-${product.sku}` || !PRODUCT_ID.test(product.id)) throw menuInvalid(`${at}.id`, 'must be hd-<sku>');
    if (ids.has(product.id) || skus.has(product.sku)) throw menuInvalid(`${at}.sku`, 'must not repeat a SKU');
    ids.add(product.id); skus.add(product.sku);
    text(product.retailer, `${at}.retailer`, { max: 80 }); text(product.name, `${at}.name`, { max: 160 });
    if (!['shelving', 'storage'].includes(product.section) || GROUPS.get(product.group) !== product.section) throw menuInvalid(`${at}.group`, 'must be a group of the shelving or extra storage step');
    count(product.unitsPerPack, `${at}.unitsPerPack`, 1, 1000);
    count(product.retailPerPackCents, `${at}.retailPerPackCents`, 1, MAX_ITEM_CENTS);
    count(product.perOrderPackLimit, `${at}.perOrderPackLimit`, 1, 1000, true);
    httpsUrl(product.productUrl, `${at}.productUrl`, ['homedepot.com']);
    httpsUrl(product.photoUrl, `${at}.photoUrl`, ['thdstatic.com', 'homedepot.com'], true);
    text(product.fitWarnings, `${at}.fitWarnings`, { max: 1000, nullable: true });
    shape(product.evidence, `${at}.evidence`, ['checkedOn', 'sourceUrl', 'note']);
    if (typeof product.evidence.checkedOn !== 'string' || !DATE.test(product.evidence.checkedOn) || product.evidence.checkedOn > menu.generatedOn) throw menuInvalid(`${at}.evidence.checkedOn`, 'must be a date no later than generatedOn');
    httpsUrl(product.evidence.sourceUrl, `${at}.evidence.sourceUrl`, ['homedepot.com']);
    text(product.evidence.note, `${at}.evidence.note`, { max: 300 });
    if (product.status !== 'draft') throw menuInvalid(`${at}.status`, 'must be draft: the owner approves goods prices in the Hub');
  });
  let full = 0;
  menu.services.forEach((service, index) => {
    const at = `menu.services[${index}]`;
    shape(service, at, SERVICE_KEYS, ['garageSize', 'approvedPriceCents', 'approval', 'scopeNote']);
    if (typeof service.id !== 'string' || !SERVICE_ID.test(service.id) || service.menuId !== service.id.toUpperCase()) throw menuInvalid(`${at}.id`, 'must be egc-NNN matching menuId EGC-NNN');
    if (ids.has(service.id)) throw menuInvalid(`${at}.id`, 'must not repeat an item id');
    ids.add(service.id);
    if (service.section !== 'removal' || GROUPS.get(service.group) !== 'removal') throw menuInvalid(`${at}.group`, 'must be a group of the removal / cleanout step');
    if (!['removal', 'service'].includes(service.category)) throw menuInvalid(`${at}.category`, 'must be removal or service');
    text(service.name, `${at}.name`, { max: 160 });
    if (!MENU_UNITS.includes(service.unit)) throw menuInvalid(`${at}.unit`, `must be one of ${MENU_UNITS.join(', ')}`);
    if (service.garageSize !== undefined && !GARAGE_SIZES.includes(service.garageSize)) throw menuInvalid(`${at}.garageSize`, 'must be 1, 2, 3 or other');
    const basis = service.basis;
    if (plain(basis) && basis.kind === 'junk') {
      shape(basis, `${at}.basis`, ['kind', 'fraction']);
      if (!JUNK_FRACTIONS.includes(basis.fraction) || service.group !== 'junk') throw menuInvalid(`${at}.basis.fraction`, 'must be a junk load fraction of 0.25, 0.5, 0.75 or 1');
      if (basis.fraction === 1) full++;
    } else {
      shape(basis, `${at}.basis`, ['kind', 'table', 'key']);
      if (basis.kind !== 'walkthrough' || !WALKTHROUGH_TABLES.includes(basis.table)) throw menuInvalid(`${at}.basis`, 'must name a walkthrough price table or a junk fraction');
      text(basis.key, `${at}.basis.key`, { max: 80 });
      if (['sizeBase', 'deep_clean'].includes(basis.table) && (service.garageSize !== basis.key)) throw menuInvalid(`${at}.garageSize`, 'must match the garage size the price is for');
    }
    if (!['draft', 'approved'].includes(service.status)) throw menuInvalid(`${at}.status`, 'must be draft or approved');
    if (service.status === 'approved') {
      count(service.approvedPriceCents, `${at}.approvedPriceCents`, 1, MAX_ITEM_CENTS);
      text(service.approval, `${at}.approval`, { max: 400 });
    } else if (service.approvedPriceCents !== undefined || service.approval !== undefined) throw menuInvalid(`${at}.approvedPriceCents`, 'only an approved item records an approved amount');
    if (service.scopeNote !== undefined) text(service.scopeNote, `${at}.scopeNote`, { max: 600 });
  });
  if (full !== 1) throw menuInvalid('menu.services', 'must list exactly one full truck load');
  return menu;
}

/** A labor rate the owner may set: whole cents per man-hour from $1.00 to $1,000.00. */
export const validLaborRate = value => Number.isSafeInteger(value) && value >= LABOR_RATE_LIMITS.min && value <= LABOR_RATE_LIMITS.max;

/** Approvals as stored in pricingMenuApprovals/current: {items: {[id]: {unitCents, identity, ...}}, revision,
 * goodsInstallationIncluded?, laborRatePerManHourCents?}. */
export function validateMenuApprovals(value) {
  if (value === null || value === undefined) return { items: {}, revision: null };
  if (!plain(value) || !plain(value.items) || !(value.revision === null || typeof value.revision === 'string') || !(value.goodsInstallationIncluded === undefined || typeof value.goodsInstallationIncluded === 'boolean')
    || !(value.laborRatePerManHourCents === undefined || validLaborRate(value.laborRatePerManHourCents))) throw fail('approvals_invalid', 'The saved price approvals failed verification. Nothing was priced; the owner must re-save them.', 503);
  for (const [id, entry] of Object.entries(value.items)) {
    if (!(PRODUCT_ID.test(id) || SERVICE_ID.test(id)) || !plain(entry) || !Number.isSafeInteger(entry.unitCents) || entry.unitCents < 1 || entry.unitCents > MAX_ITEM_CENTS
      || !(entry.identity === undefined || typeof entry.identity === 'string' && entry.identity.length <= 600)) throw fail('approvals_invalid', 'The saved price approvals failed verification. Nothing was priced; the owner must re-save them.', 503);
  }
  return value;
}

/**
 * What an owner approval was given for. A menu re-import may keep an item id but rename or re-map it (another
 * special item under EGC-031, a new pack size under the same SKU): the stored identity then no longer matches and
 * the approval stops counting. A service is its menu id, name, unit, group, price basis and garage size; a product
 * its SKU, units per pack and step (its price is checked separately against cost x goodsMarkup).
 */
export function menuItemIdentity(item) {
  if (PRODUCT_ID.test(item?.id || '')) return `product|${item.sku}|${item.unitsPerPack}|${item.section}`;
  const basis = item.basis.kind === 'junk' ? `junk:${item.basis.fraction}` : `${item.basis.table}:${item.basis.key}`;
  return `service|${item.menuId}|${item.name}|${item.unit}|${item.group}|${basis}|${item.garageSize || ''}`;
}

// The draft amount of a walkthrough-table service, in cents. A broken mapping fails closed.
function tableCents(walkthrough, basis) {
  const t = walkthrough || {};
  const dollars = basis.table === 'sizeBase' ? t.sizeBase?.[basis.key]
    : basis.table === 'services' ? t.services?.[basis.key]?.amount
      : basis.table === 'deep_clean' ? t.services?.deep_clean?.bySize?.[basis.key]?.amount
        : basis.table === 'hazards' ? t.hazards?.[basis.key]?.amount
          : basis.table === 'special' ? t.special?.[basis.key]
            : basis.table === 'access' ? t.access?.[basis.key] : undefined;
  const cents = typeof dollars === 'number' && Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
  if (!Number.isSafeInteger(cents) || cents > MAX_ITEM_CENTS) throw fail('unavailable', 'A pricing-menu item no longer matches the walkthrough price tables. Nothing was priced; tell the office.', 503, { table: basis.table, key: basis.key });
  return cents;
}

/**
 * Every menu item's current price and approval for one pricing state:
 * Map id -> {item, kind:'product'|'service', unitCents, approved, source:'menu'|'owner'|'draft', reason}.
 * The state is {menu, settings, walkthrough, approvals}; settings are validated here.
 */
export function menuPrices(state) {
  const { menu, settings, walkthrough } = state || {};
  if (!menu || !settings) throw fail('unavailable', 'The pricing menu could not be verified. Keep the quote and retry.', 503);
  validatePricingSettings(settings);
  const approvals = validateMenuApprovals(state.approvals).items, markup = goodsMarkupOf(settings).basisPoints;
  // An owner approval counts only for the item it was given for; one for an earlier version of the item is stale.
  const ownerOf = item => { const entry = approvals[item.id]; return entry ? { unitCents: entry.unitCents, stale: entry.identity !== menuItemIdentity(item) } : null; };
  const staleReason = (owner, unitCents, unit = '') => `The owner approved ${money(owner.unitCents)}${unit} for an earlier version of this menu item; a menu re-import changed it (name, unit, pack or price basis), so the owner must approve it again. Draft price ${money(unitCents)}${unit}.`;
  const out = new Map();
  const full = menu.services.find(service => service.basis.kind === 'junk' && service.basis.fraction === 1), fullOwner = full ? ownerOf(full) : null;
  const fullCents = (full?.status === 'approved' ? full.approvedPriceCents : fullOwner && !fullOwner.stale ? fullOwner.unitCents : null) ?? null;
  for (const service of menu.services) {
    const fixed = service.status === 'approved' ? service.approvedPriceCents : null, prior = ownerOf(service), owner = prior && !prior.stale ? prior.unitCents : null;
    // A partial load is a proportional draft of the full-truck price until the owner approves its own amount;
    // with no full-truck price at all a load has no price and cannot be quoted.
    const draft = service.basis.kind === 'junk' ? (fullCents && service.basis.fraction < 1 ? Math.round(fullCents * service.basis.fraction) : null) : tableCents(walkthrough, service.basis);
    const unitCents = fixed ?? owner ?? draft;
    const source = fixed !== null ? 'menu' : owner !== null ? 'owner' : 'draft';
    // The walkthrough's size base is its full-service reset price, which already covers hauling: the builder adds
    // truck loads on top, so that number is only a placeholder until the owner sets the cleaning-only amount.
    const draftReason = service.basis.table === 'sizeBase' ? `Draft price ${money(unitCents)} is the walkthrough's historical full-service base, which already included hauling; the owner sets the cleaning-only amount.` : `Draft price ${money(unitCents)}, not yet approved by the owner.`;
    out.set(service.id, { item: service, kind: 'service', unitCents, approved: source !== 'draft', source,
      reason: unitCents === null ? 'No price yet: the owner must approve a full truck load price first.' : source === 'menu' ? service.approval : source === 'owner' ? 'Owner-approved price.' : prior?.stale ? staleReason(prior, unitCents) : draftReason });
  }
  for (const product of menu.products) {
    const unitCents = roundCents(product.retailPerPackCents * markup, 10000, settings.roundingRule), owner = ownerOf(product);
    const approved = Boolean(owner && !owner.stale && owner.unitCents === unitCents);
    out.set(product.id, { item: product, kind: 'product', unitCents, approved, source: approved ? 'owner' : 'draft',
      reason: approved ? 'Owner-approved price.' : owner?.stale ? staleReason(owner, unitCents, ' per pack') : owner ? `The owner approved ${money(owner.unitCents)} per pack, but the current price is ${money(unitCents)}; the owner must approve the new price.` : `Draft price ${money(unitCents)} per pack, not yet approved by the owner.` });
  }
  return out;
}

// Goods are priced at cost x goodsMarkup with no installation of their own: a builder quote bills installation through
// its Labor line (D12), whose time estimate (laborEstimate) includes the install time of every good it can time. Goods
// it cannot time (installNotEstimated) wait until the estimator sets the man-hours by hand (labor.adjusted) after the
// review step named them, or the owner confirms that installation is included in the goods price: the pricing settings'
// goodsInstallationIncluded (the Pricing tab, which needs CATALOG_QUOTES_ENABLED) or the menu approvals' (Menu prices,
// which the quote builder flag alone opens). A quote saved before the Labor line existed (no breakdown.labor) waits for
// the owner's answer alone, as before.
const installationIncluded = state => state?.settings?.goodsInstallationIncluded === true || state?.approvals?.goodsInstallationIncluded === true;
const INSTALLATION_BLOCK = Object.freeze({ id: INSTALLATION_ID, name: 'Shelving and storage installation', unitCents: null,
  reason: 'Shelving and storage installation is not priced: this quote was saved before builder quotes had a Labor line, its goods sell at public retail × the goods markup only, and the owner has not confirmed in Hub > Catalog & pricing (Menu prices) that installation is included in that price. Edit the quote and save it again to add the Labor line.' });
const installTimeBlock = missing => {
  const names = missing.map(row => row.name), listed = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  return { id: INSTALLATION_ID, name: 'Shelving and storage installation', unitCents: null,
    reason: `The labor estimate has no install time for ${listed}, so the pre-filled man-hours do not include installing ${names.length === 1 ? 'it' : 'them'}. Adjust the man-hours on the review step to include the installation and save the quote again, or the owner confirms in Hub > Catalog & pricing (Menu prices) that installation is included in the goods price.` };
};

// ---- Labor (D12) ----
const quarterHours = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
/** Man-hours a Labor line may charge: 0.5 to 200, in quarter hours. */
export const validManHours = value => quarterHours(value) && value >= LABOR_MAN_HOURS.min && value <= LABOR_MAN_HOURS.max;
/** The labor rate in force: {rateCents, source:'owner'|'default', reason}. The owner's own rate (menu approvals
 * laborRatePerManHourCents, set on Menu prices) else the owner's $53.00 of 2026-10-19 (DEFAULT_LABOR_RATE_CENTS). Either is
 * approved: it is the owner's decision. */
export function laborRate(state) {
  const owner = state?.approvals?.laborRatePerManHourCents;
  return validLaborRate(owner) ? { rateCents: owner, source: 'owner', reason: 'Owner-set labor rate.' } : { rateCents: DEFAULT_LABOR_RATE_CENTS, source: 'default', reason: LABOR_DEFAULT_REASON };
}
/** The Labor line's amount: man-hours x rate, rounded half up to the cent (quarter hours times whole cents). */
export const laborTotalCents = (manHours, rateCents) => Math.round(Math.round(manHours * 4) * rateCents / 4);
/** Person-minutes as the man-hours a Labor line charges: to the nearest quarter hour, within 0.5 to 200. */
export const manHoursOf = personMinutes => Math.min(LABOR_MAN_HOURS.max, Math.max(LABOR_MAN_HOURS.min, Math.round(personMinutes / 15) / 4));

/**
 * The labor time model, in person-minutes: the walkthrough's own model (pricing-config.js WALKTHROUGH_MINUTES and the
 * legacy service minutes, the numbers crew/gameplan.html estimatedJobMinutes() books the crew's time from), whose minutes
 * are elapsed minutes for its calibrated crew (calibratedCrew, 2), each multiplied by that crew. Unlike the schedule's
 * wall-clock estimate, nothing is divided by the crew chosen on the Schedule tab, rounded to 30 minutes or kept within
 * one working day, so the same work has the same man-hours for any crew and any length of job.
 * D-JUNK ("$750 per truck covers the crew's time"): the model's minutes are kept or dropped by what they time, per the
 * walkthrough's own model and the menu's scope notes.
 *   base       kept: once per quote (arrival, set-up and sweep-out)
 *   fill       kept, with a garage cleaning base: the fullness minutes of the walkthrough's "How full is it?" (unknown:
 *              defaultFill), the time to sort through the garage's contents. The walkthrough prices the fullness on the
 *              garage base (recommend(): size base x fill), never on the truck loads, which it prices per load.
 *   cleaning   kept, per unit: the deep clean by size, the pressure wash, mouse trapping and pest-waste cleanup at their
 *              walkthrough minutes; a cleaning base adds nothing of its own (base and fill cover it)
 *   install    kept, per goods pack: a shelving unit at the walkthrough's shelving-unit minutes, a tote at its
 *              labeled-tote minutes, each x units per pack (the times the walkthrough's Finish step charged for the same
 *              goods). Every other product has no install time yet: null, and laborEstimate names it (installNotEstimated).
 *   dropped    the hauling (HAULING_GROUPS, 0 here): truck loads (perLoad, minLoads: loading, hauling and disposal, paid by
 *              the truck price), special-handling items (perSpecial: their price is the item's "incremental disposal/
 *              handling") and access charges (access: "incremental labor only", priced on their own line).
 * null when the walkthrough time model is unavailable: the estimator then enters the man-hours by hand.
 */
function laborTime(state) {
  const w = state?.walkthrough, M = w?.minutes, svc = w?.services, crew = M?.calibratedCrew, menu = state?.menu;
  const n = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  if (!plain(M) || !plain(svc) || !Number.isSafeInteger(crew) || crew < 1 || !plain(M.fill) || !menu
    || [M.base, M.defaultFill].some(value => n(value) === null)) return null;
  const pm = minutes => (n(minutes) ?? 0) * crew;
  const service = item => {
    const { table, key } = item.basis;
    if (HAULING_GROUPS.includes(item.group)) return 0;
    if (table === 'deep_clean') return pm(svc.deep_clean?.bySize?.[key]?.minutes);
    if (table === 'services') return pm(svc[key]?.minutes);
    if (table === 'hazards') return pm(w.hazards?.[key]?.minutes);
    return 0;
  };
  const shelf = n(svc.shelving?.byType?.[svc.shelving?.defaultType]?.minutes), tote = n(svc.totes?.minutes);
  const install = product => { const unit = product.group === 'shelving' ? shelf : product.group === 'bins-totes' ? tote : null; return unit === null ? null : unit * crew * product.unitsPerPack; };
  const items = new Map([...menu.services.map(item => [item.id, { item, minutes: item.basis.kind === 'junk' ? 0 : service(item) }]), ...menu.products.map(item => [item.id, { item, minutes: install(item) }])]);
  return { base: pm(M.base), defaultFill: pm(M.defaultFill), fill: Object.fromEntries(FULLNESS.map(key => [key, n(M.fill[key]) === null ? pm(M.defaultFill) : pm(M.fill[key])])), items };
}
/**
 * The time estimate of one normalized builder selection (laborTime): {personMinutes, removalPersonMinutes (the removal /
 * cleanout step's garage work: set-up and sweep-out, sorting and cleaning; never hauling), installPersonMinutes, fullness,
 * installNotEstimated:[{id, name, packs}], manHours (manHoursOf)}, or null without the time model. Example: a two-car
 * base, one full truck load in a medium-full garage and two shelving units = 2 x (60 + 30) + 2 x 60 = 300 person-minutes
 * = 5 man-hours ($265.00 at $53.00), for a crew of 2 or of 4; the truck load's own $750 pays its loading and hauling.
 */
export function laborEstimate(selection, state) {
  const time = laborTime(state);
  if (!time) return null;
  const fullness = fullnessOf(selection?.labor?.fullness);
  let removal = time.base, sorted = false, install = 0;
  const missing = [];
  for (const entry of Array.isArray(selection?.removal) ? selection.removal : []) {
    const row = time.items.get(entry.id);
    if (!row) continue;
    if (row.item.group === 'cleaning-base') sorted = true;
    removal += row.minutes * entry.quantity;
  }
  if (sorted) removal += fullness ? time.fill[fullness] : time.defaultFill;
  for (const step of ['shelving', 'storage']) for (const entry of Array.isArray(selection?.[step]) ? selection[step] : []) {
    const row = time.items.get(entry.id);
    if (!row) continue;
    if (row.minutes === null) missing.push({ id: entry.id, name: row.item.name, packs: entry.quantity }); else install += row.minutes * entry.quantity;
  }
  const personMinutes = Math.round(removal + install);
  return { personMinutes, removalPersonMinutes: Math.round(removal), installPersonMinutes: Math.round(install), fullness, installNotEstimated: missing, manHours: manHoursOf(personMinutes) };
}
// The browser's labor selection {manHours, adjusted, fullness}: manHours null asks for the estimate; adjusted says the
// estimator set the man-hours by hand (it needs a number). Anything else is refused.
function normalizeLabor(value) {
  if (!keysOnly(value, LABOR_KEYS) || !Object.hasOwn(value, 'manHours')) throw fail('invalid_labor', 'The labor selection is incomplete. Reload the builder and try again.');
  if (value.manHours !== null && !validManHours(value.manHours)) throw fail('invalid_labor', `Enter the labor as ${LABOR_MAN_HOURS.min} to ${LABOR_MAN_HOURS.max} man-hours in quarter hours (like 6 or 6.25).`, 400, { min: LABOR_MAN_HOURS.min, max: LABOR_MAN_HOURS.max, step: LABOR_MAN_HOURS.step });
  if (!(value.adjusted === undefined || typeof value.adjusted === 'boolean') || value.adjusted === true && value.manHours === null) throw fail('invalid_labor', 'The labor selection is incomplete. Reload the builder and try again.');
  const fullness = value.fullness ?? null;
  if (fullness !== null && !FULLNESS.includes(fullness)) throw fail('invalid_labor', 'The garage fullness behind the labor estimate is invalid: light, medium, full or packed.');
  return { manHours: value.manHours, adjusted: value.adjusted === true, fullness };
}
/** The priced Labor of one selection: {version, manHours, rateCents, rateSource, totalCents, prefilledManHours, adjusted,
 * belowEstimate, estimate}. version is LABOR_VERSION; prefilledManHours is the server's estimate now (laborEstimate),
 * never the browser's; adjusted is the estimator's own action; belowEstimate (the man-hours are under the estimate) is for
 * the owner. manHours (and totalCents) stay null while the estimator has neither an estimate nor a number. */
function pricedLabor(labor, estimate, state) {
  const prefilled = estimate ? estimate.manHours : null, manHours = labor.manHours ?? prefilled, rate = laborRate(state);
  return { version: LABOR_VERSION, manHours, rateCents: rate.rateCents, rateSource: rate.source, totalCents: manHours === null ? null : laborTotalCents(manHours, rate.rateCents),
    prefilledManHours: prefilled, adjusted: labor.manHours !== null && labor.adjusted === true, belowEstimate: manHours !== null && prefilled !== null && manHours < prefilled,
    estimate: estimate && { personMinutes: estimate.personMinutes, removalPersonMinutes: estimate.removalPersonMinutes, installPersonMinutes: estimate.installPersonMinutes, fullness: estimate.fullness, installNotEstimated: estimate.installNotEstimated } };
}
// Why a breakdown's labor cannot be sent as it is, or null when it can (approvalOf). An unsent quote must carry today's
// rate and Labor rules (LABOR_VERSION; junk: a junk-only quote has none); a signed one (signed) keeps the rate and the
// line the customer signed, which were approved then, as long as its amount is its man-hours x that rate.
function laborBlock(labor, state, { required, signed, junk = false }) {
  const rate = laborRate(state).rateCents, row = reason => ({ id: LABOR_ID, name: 'Labor', unitCents: plain(labor) && Number.isSafeInteger(labor.rateCents) ? labor.rateCents : null, reason });
  if (junk && !signed) return labor === undefined || labor === null ? null
    : row('This junk-only quote still has a Labor line from before the owner\'s decision of 2026-10-18: the truck-load price covers the crew\'s time, so a junk-only quote has no Labor line. Edit the quote and save it again to drop it.');
  if (labor === undefined || labor === null) return required ? row(`This quote has no Labor line. Every builder quote with garage work charges labor: the estimated man-hours × ${money(rate)} per man-hour. Edit the quote, check the man-hours and save it again.`) : null;
  if (!plain(labor) || !validManHours(labor.manHours)) return row('Enter the estimated man-hours for the Labor line, then save the quote again.');
  if (signed) return validLaborRate(labor.rateCents) && labor.totalCents === laborTotalCents(labor.manHours, labor.rateCents) ? null
    : row('The labor amount on this signed quote does not equal its man-hours × the labor rate it was signed at. Review the job\'s quote with the office before it is sent.');
  if (labor.version !== LABOR_VERSION) return row('This quote was saved before the owner\'s Labor decisions of 2026-10-18: its man-hours estimate counted truck-load time the truck price already covers, and its Labor line showed the customer the man-hours. Edit the quote, check the man-hours on the review step and save it again.');
  if (labor.rateCents !== rate) return row(`The labor rate is now ${money(rate)} per man-hour, but this quote has ${Number.isSafeInteger(labor.rateCents) ? money(labor.rateCents) : 'another rate'}. Save the quote again to use the current rate.`);
  if (labor.totalCents !== laborTotalCents(labor.manHours, rate)) return row('The labor amount on this quote does not equal its man-hours × the labor rate. Save the quote again.');
  return null;
}

/** The builder's menu for one viewer. internal (owner/manager) adds the goods cost basis, the multiplier and the
 * approvals revision the owner's bulk approval needs; nobody else sees a cost. labor is the rate in force (approved),
 * the man-hour limits the builder's Labor row accepts, the removal groups a junk-only quote is made of (haulingGroups:
 * no Labor line) and the time model the server estimates the man-hours with (labor.time, laborTime: person-minutes, no
 * money; no truck-load minutes), so the running total shows the same estimate: each service's laborPersonMinutes per
 * unit (0 for hauling) and each product's installPersonMinutes per pack (null: no install time yet). */
export function builderMenu(state, { internal = false, canApprove = false } = {}) {
  const prices = menuPrices(state), { menu, settings } = state, approvals = validateMenuApprovals(state.approvals), rate = laborRate({ approvals }), time = laborTime(state);
  const status = id => { const price = prices.get(id); return { unitCents: price.unitCents, approved: price.approved, source: price.source, reason: price.reason }; };
  const minutes = id => time ? time.items.get(id).minutes : null;
  return {
    menuVersion: menu.menuVersion, settingsVersion: settings.settingsVersion, evidenceDate: menu.generatedOn,
    steps: BUILDER_STEPS, sections: BUILDER_SECTIONS, maxChargedLines: MAX_CHARGED_LINES,
    services: menu.services.map(service => ({ id: service.id, menuId: service.menuId, section: service.section, category: service.category, group: service.group, name: service.name, unit: service.unit,
      ...(service.garageSize ? { garageSize: service.garageSize } : {}), ...(service.basis.kind === 'junk' ? { junkFraction: service.basis.fraction } : { walkthroughKey: service.basis.key }),
      ...(service.scopeNote ? { scopeNote: service.scopeNote } : {}), laborPersonMinutes: minutes(service.id), ...status(service.id) })),
    products: menu.products.map(product => ({ id: product.id, sku: product.sku, retailer: product.retailer, name: product.name, section: product.section, group: product.group,
      unitsPerPack: product.unitsPerPack, perOrderPackLimit: product.perOrderPackLimit, productUrl: product.productUrl, photoUrl: product.photoUrl, fitWarnings: product.fitWarnings,
      installPersonMinutes: minutes(product.id), ...status(product.id), ...(internal ? { retailPerPackCents: product.retailPerPackCents, evidence: product.evidence } : {}) })),
    // installationConfirmed: the owner's own answer on Menu prices (menu.approve), present once it was given. It matters
    // for goods the labor estimate cannot time and for a quote saved before the Labor line existed.
    ...(internal ? { internal: { goodsMarkup: goodsMarkupOf(settings).multiplier, goodsInstallationIncluded: installationIncluded(state), roundingRule: settings.roundingRule, approvalsRevision: approvals.revision,
      ...(typeof approvals.goodsInstallationIncluded === 'boolean' ? { installationConfirmed: approvals.goodsInstallationIncluded } : {}) } } : {}),
    // The labor rate is the owner's decision: every viewer sees it, approved. Installation is billed through it.
    labor: { rateCents: rate.rateCents, approved: true, source: rate.source, reason: rate.reason, minManHours: LABOR_MAN_HOURS.min, maxManHours: LABOR_MAN_HOURS.max, stepManHours: LABOR_MAN_HOURS.step, version: LABOR_VERSION, haulingGroups: HAULING_GROUPS,
      time: time ? { basePersonMinutes: time.base, fillPersonMinutes: time.fill, defaultFillPersonMinutes: time.defaultFill } : null },
    installation: { included: installationIncluded(state), billedAs: 'labor' },
    viewer: { internal, canApprove: internal && canApprove },
  };
}

// The selection a browser sends: {menuVersion, settingsVersion, steps, removal, shelving, storage, labor?, garageSize?}.
// labor is {manHours: number|null, adjusted?: boolean, fullness?: string|null} (normalizeLabor); a save of a quote with
// garage work needs it (priceCompositeQuote), except the re-pricing of a job signed before builder quotes had a Labor line.
// garageSize is the walkthrough's garage size ('1', '2', '3' or 'other'; crew/gameplan.html Photos): without a garage
// cleaning base (a quote with truck loads) it sizes the deep clean and allows the one-car pressure wash (checkRemoval).
// It is kept only when sent, so a selection saved without it reads exactly as before. The signed handoff replaces it
// with the signed plan's own (scope.garages).
const DESCRIPTOR_KEYS = ['menuVersion', 'settingsVersion', 'steps', 'removal', 'shelving', 'storage', 'labor', 'garageSize'];
function normalizeDescriptor(descriptor, { complete }) {
  if (!keysOnly(descriptor, DESCRIPTOR_KEYS) || typeof descriptor.menuVersion !== 'string' || typeof descriptor.settingsVersion !== 'string' || !Array.isArray(descriptor.steps)) {
    throw fail('invalid_selection', 'The quote builder selection is incomplete. Reload the builder and try again.');
  }
  const steps = descriptor.steps;
  if (!steps.length || steps.length > BUILDER_STEPS.length || steps.some((step, index) => step !== BUILDER_STEPS[index])) {
    throw fail('order', 'Build the quote in order: removal / cleanout first, then shelving, then extra storage.', 400, { steps: BUILDER_STEPS });
  }
  if (complete && steps.length !== BUILDER_STEPS.length) throw fail('incomplete', 'Finish all three steps (removal / cleanout, shelving and extra storage) before saving the quote.', 400, { steps: BUILDER_STEPS });
  const out = { menuVersion: descriptor.menuVersion, settingsVersion: descriptor.settingsVersion, steps: [...steps] };
  let total = 0;
  for (const step of BUILDER_STEPS) {
    const raw = descriptor[step] === undefined ? [] : descriptor[step];
    if (!Array.isArray(raw)) throw fail('invalid_selection', 'Each builder step must list its selections.');
    if (raw.length && !steps.includes(step)) throw fail('order', `Finish the earlier steps before adding ${SECTION_LABEL.get(step).toLowerCase()}. The quote is always built removal / cleanout, then shelving, then extra storage.`, 400, { steps: BUILDER_STEPS });
    const seen = new Set();
    out[step] = raw.map(entry => {
      if (!keysOnly(entry, ['id', 'quantity']) || typeof entry.id !== 'string' || !(step === 'removal' ? SERVICE_ID : PRODUCT_ID).test(entry.id) || seen.has(entry.id) || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > MAX_PACKS) {
        throw fail('invalid_selection', 'Each builder selection needs a distinct menu item and a whole quantity.');
      }
      seen.add(entry.id);
      return { id: entry.id, quantity: entry.quantity };
    });
    total += out[step].length;
  }
  if (total > MAX_SELECTIONS) throw fail('invalid_selection', `A quote can hold at most ${MAX_SELECTIONS} builder selections.`);
  if (descriptor.labor !== undefined) out.labor = normalizeLabor(descriptor.labor);
  if (descriptor.garageSize !== undefined && descriptor.garageSize !== null) {
    if (!GARAGE_SIZES.includes(descriptor.garageSize)) throw fail('invalid_selection', 'The walkthrough garage size is invalid: 1, 2, 3 or other.');
    out.garageSize = descriptor.garageSize;
  }
  return out;
}

// The removal step's rules: one garage base, at most one partial load, a deep clean sized to the garage, a pressure
// wash for a one-car garage only, and bounded quantities. The garage is the cleaning base's size, else (no base: a
// quote with truck loads) the walkthrough's garage size the selection names (garageSize), else unknown: a deep clean
// of any one size, and no pressure wash.
function checkRemoval(entries, prices, garageSize = null) {
  const byGroup = group => entries.filter(entry => prices.get(entry.id).item.group === group);
  const bases = byGroup('cleaning-base'), partial = byGroup('junk').filter(entry => prices.get(entry.id).item.basis.fraction < 1), full = byGroup('junk').filter(entry => prices.get(entry.id).item.basis.fraction === 1);
  if (bases.length > 1 || bases.some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Choose one garage cleaning base for the garage size.');
  if (partial.length > 1 || partial.some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Choose at most one partial load (a quarter, half or three-quarter truck).');
  if (full.some(entry => entry.quantity > MAX_FULL_LOADS)) throw fail('invalid_selection', `Quote at most ${MAX_FULL_LOADS} full truck loads.`);
  if (byGroup('special').some(entry => entry.quantity > MAX_SPECIAL)) throw fail('invalid_selection', `Quote at most ${MAX_SPECIAL} of one special-handling item.`);
  if ([...byGroup('access'), ...byGroup('cleaning')].some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Access charges and cleaning add-ons are quoted once.');
  const size = bases.length ? prices.get(bases[0].id).item.garageSize : garageSize;
  const sized = byGroup('cleaning').map(entry => prices.get(entry.id).item).filter(item => item.basis.table === 'deep_clean');
  if (sized.length > 1) throw fail('invalid_selection', 'Choose one deep clean, sized to the garage.');
  if (size && sized.some(item => item.garageSize !== size)) throw fail('invalid_selection', bases.length ? 'The deep clean must match the garage cleaning base size.' : 'The deep clean must match the walkthrough\'s garage size.');
  if (byGroup('cleaning').some(entry => prices.get(entry.id).item.basis.key === 'pressure_wash') && size !== '1') throw fail('invalid_selection', bases.length ? 'Pressure washing is quoted for a one-car garage cleaning base only.' : 'Pressure washing is quoted for a one-car garage only.');
}

/**
 * Prices one builder selection. complete:true (a save) requires all three steps and, for a quote with garage work, the
 * labor; a junk-only quote (junkOnly, D-JUNK) has no Labor line, and any labor its selection sends is dropped.
 * requireLabor:false (only for re-pricing the selection of a job the customer signed before builder quotes had a Labor
 * line) prices a complete selection without labor by the earlier rules. Returns:
 *   compositePricing  the normalized selection (what a save stores and a revision re-sends); its labor.manHours is
 *                     the man-hours priced (the pre-fill when the browser asked for it with null); no labor when junk-only
 *   lineItems         the customer-facing quote-model lines (no cost split), in step order, then the Labor line
 *                     ("Labor": one amount, D-LABOR-TEXT)
 *   storedLineItems   the same lines with the internal goods cost split, for the Hub job only
 *   breakdown         the itemized, cost-free job breakdown by section (see quoteBreakdown), with breakdown.labor
 *   steps             [{id,label,subtotalCents,runningTotalCents}] for the completed steps, then labor once priced
 *   labor             {version, manHours, rateCents, rateSource, totalCents, prefilledManHours, adjusted, belowEstimate,
 *                     estimate} (pricedLabor) or null when the selection sent none (a step preview) or is junk-only
 *   junkOnly          true for a junk-only selection: $750 per truck, no Labor line
 *   approval          {ready, blocked:[{id,name,unitCents,reason}]}: ready false blocks sending
 */
export function priceCompositeQuote(state, descriptor, { complete = false, requireLabor = true } = {}) {
  const selection = normalizeDescriptor(descriptor, { complete });
  const { menu, settings } = state || {};
  if (!menu || !settings) throw fail('unavailable', 'The pricing menu could not be verified. Keep the quote and retry.', 503);
  if (selection.menuVersion !== menu.menuVersion || selection.settingsVersion !== settings.settingsVersion) {
    throw fail('version_changed', 'Prices changed since the builder opened. Reload the builder and review the current prices before saving.', 409);
  }
  const prices = menuPrices(state), version = menu.menuVersion;
  const priceOf = (entry, section) => {
    const price = prices.get(entry.id);
    if (!price || (section === 'removal' ? price.kind !== 'service' : price.kind !== 'product' || price.item.section !== section)) {
      throw fail('wrong_step', price ? `${price.item.name} belongs to the ${SECTION_LABEL.get(price.item.section).toLowerCase()} step.` : 'One selected item is no longer on the pricing menu. Reload the builder.', price ? 400 : 409);
    }
    if (price.unitCents === null) throw fail('item_unavailable', `${price.item.name} has no price yet. ${price.reason}`, 409);
    return price;
  };
  const removal = selection.removal.map(entry => ({ entry, price: priceOf(entry, 'removal') }));
  checkRemoval(selection.removal, prices, selection.garageSize ?? null);
  // Removal lines follow the step's group order; full truck loads come before a partial load.
  const fraction = pair => pair.price.item.basis.kind === 'junk' ? -pair.price.item.basis.fraction : 0;
  removal.sort((a, b) => REMOVAL_GROUP_ORDER.indexOf(a.price.item.group) - REMOVAL_GROUP_ORDER.indexOf(b.price.item.group) || fraction(a) - fraction(b) || menu.services.indexOf(a.price.item) - menu.services.indexOf(b.price.item));
  const goods = step => selection[step].map(entry => ({ entry, price: priceOf(entry, step) }));
  const detail = [], model = [];
  const lineCents = (unit, quantity) => { const total = unit * quantity; if (!Number.isSafeInteger(total) || total > MAX_TOTAL_CENTS) throw fail('amount_too_large', 'This selection exceeds the $1,000,000 quote limit.'); return total; };
  const itemize = ({ entry, price }, lineItemId) => {
    const item = price.item, product = price.kind === 'product';
    detail.push({ id: item.id, lineItemId, section: product ? item.section : 'removal', category: product ? item.section : item.category, group: item.group,
      menuId: product ? null : item.menuId, sku: product ? item.sku : null, retailer: product ? item.retailer : null, name: item.name,
      qty: entry.quantity, unit: product ? 'pack' : item.unit, unitsPerPack: product ? item.unitsPerPack : null,
      unitCents: price.unitCents, totalCents: lineCents(price.unitCents, entry.quantity), approved: price.approved,
      productUrl: product ? item.productUrl : null, photoUrl: product ? item.photoUrl : null,
      perOrderPackLimit: product ? item.perOrderPackLimit : null, fitWarnings: product ? item.fitWarnings : null });
  };
  const single = (pair, id, kind, name, description = '') => {
    itemize(pair, id);
    model.push({ id, kind, name, description, quantity: pair.entry.quantity, unitCents: pair.price.unitCents, totalCents: lineCents(pair.price.unitCents, pair.entry.quantity),
      optional: false, selected: true, taxable: false, catalog: { itemId: pair.price.item.id, version } });
  };
  // One customer-facing line for several picks: its description names each (with its quantity); the breakdown
  // keeps every pick, pointing at the line it rolls into.
  const listed = (pairs, label) => { const text = pairs.map(label).join('; '); return text.length > 600 ? `${text.slice(0, 599).trimEnd()}…` : text; };
  const rolled = (pairs, id, name, { kind = 'fee', label = pair => pair.entry.quantity > 1 ? `${pair.price.item.name} × ${pair.entry.quantity}` : pair.price.item.name, extra = {} } = {}) => {
    if (!pairs.length) return;
    pairs.forEach(pair => itemize(pair, id));
    const total = pairs.reduce((sum, pair) => sum + lineCents(pair.price.unitCents, pair.entry.quantity), 0);
    model.push({ id, kind, name, description: listed(pairs, label), quantity: 1, unitCents: total, totalCents: lineCents(total, 1), optional: false, selected: true, taxable: false, ...extra });
  };
  const inGroup = group => removal.filter(pair => pair.price.item.group === group);
  for (const pair of inGroup('cleaning-base')) single(pair, 'removal-base', 'service', pair.price.item.name, 'Flat garage cleaning base for the garage size.');
  for (const pair of inGroup('junk')) {
    const full = pair.price.item.basis.fraction === 1;
    single(pair, full ? 'removal-junk-full' : 'removal-junk-partial', 'service', `Junk removal: ${pair.price.item.name.toLowerCase()}`, full ? 'Hauling and disposal by full truck load.' : 'Hauling and disposal of a partial truck load.');
  }
  rolled(inGroup('special'), 'removal-special', 'Special-handling items');
  rolled(inGroup('access'), 'removal-access', 'Access charges');
  for (const pair of inGroup('cleaning')) single(pair, `service-${pair.price.item.id}`, 'service', pair.price.item.name);
  // Each goods step is one line (every pack is itemized in the breakdown and the purchase list). The Hub job keeps
  // the step's goods cost split (like catalog quotes); previews and the breakdown carry none.
  const splits = new Map();
  for (const step of ['shelving', 'storage']) {
    const pairs = goods(step), line = GOODS_LINES[step];
    if (!pairs.length) continue;
    const packs = pair => `${pair.price.item.name} × ${pair.entry.quantity} pack${pair.entry.quantity === 1 ? '' : 's'}${pair.price.item.unitsPerPack > 1 ? ` of ${pair.price.item.unitsPerPack}` : ''}`;
    rolled(pairs, line.id, line.name, { kind: 'product', label: packs, extra: { catalog: { itemId: line.catalogId, version } } });
    const totalCents = model.at(-1).totalCents, productCents = pairs.reduce((sum, pair) => sum + lineCents(pair.price.item.retailPerPackCents, pair.entry.quantity), 0);
    splits.set(line.id, { productCents, laborCents: 0, laborMinutes: 0, markupCents: totalCents - productCents, disposalCents: 0 });
  }
  if (!model.length) throw fail('empty', 'Add at least one removal, shelving or storage item to price the quote.');
  // D-JUNK: a junk-only quote is $750 per truck. It has no Labor line, so labor the browser sent for it is dropped and
  // the saved selection carries none; every other complete quote needs its labor.
  const junk = junkOnly(detail);
  if (junk) delete selection.labor;
  else if (complete && requireLabor && !selection.labor) throw fail('labor_required', 'Every builder quote with garage work has a Labor line. Reopen the quote builder, check the man-hours on the review step and save the quote again.', 400);
  // D12: the Labor line, man-hours x the server's rate, after the menu lines. It is labor by its kind (estimateTotals
  // attributes it to laborCents) and carries no minutes, so the dispatch duration still comes from the time estimate.
  // The estimate is the server's, from this selection (laborEstimate); the saved selection keeps the man-hours priced.
  // D-LABOR-TEXT: the customer sees one amount, "Labor" (quote-model.js LABOR_LINE_NAME), never the man-hours or rate.
  const labor = selection.labor ? pricedLabor(selection.labor, laborEstimate(selection, state), state) : null;
  if (labor) selection.labor = { manHours: labor.manHours, adjusted: labor.adjusted, fullness: selection.labor.fullness };
  if (complete && labor?.manHours === null) throw fail('labor_required', 'Enter the estimated man-hours for the Labor line before saving the quote: there is no time estimate to pre-fill them from.', 400);
  if (labor?.manHours != null) {
    const goodsSold = model.some(line => line.kind === 'product');
    model.push({ id: LABOR_ID, kind: 'labor', name: LABOR_LINE_NAME, description: goodsSold ? LABOR_INSTALL_NOTE : '',
      quantity: 1, unitCents: lineCents(labor.totalCents, 1), totalCents: labor.totalCents, optional: false, selected: true, taxable: false });
  }
  if (model.filter(line => line.totalCents > 0).length > MAX_CHARGED_LINES) throw fail('too_many_lines', `A quote can charge at most ${MAX_CHARGED_LINES} lines so the customer portal shows every charge. Remove a removal item or split the work into two quotes.`, 400, { maxChargedLines: MAX_CHARGED_LINES });
  const stored = model.map(line => splits.has(line.id) ? { ...line, split: splits.get(line.id) } : line);
  let storedLineItems;
  try { storedLineItems = normalizeLineItems(stored, { strict: true }).lineItems; }
  catch (error) { throw fail('unavailable', `The builder quote could not be verified: ${error.message}`, 503); }
  const laborCents = labor?.totalCents ?? 0;
  const totals = estimateTotals(storedLineItems), totalCents = detail.reduce((sum, line) => sum + line.totalCents, 0) + laborCents;
  if (!totals.complete || totals.totalCents !== totalCents || totalCents <= 0 || storedLineItems.some(line => !included(line))) throw fail('unavailable', 'The builder quote total could not be verified. Keep the selections and retry.', 503);
  const lineItems = storedLineItems.map(({ split, durationMinutes, ...line }) => line);
  const sections = BUILDER_STEPS.map(id => ({ id, label: SECTION_LABEL.get(id), completed: selection.steps.includes(id), subtotalCents: detail.filter(line => line.section === id).reduce((sum, line) => sum + line.totalCents, 0), lineIds: detail.filter(line => line.section === id).map(line => line.id) }));
  let running = 0;
  const steps = sections.filter(section => section.completed).map(section => ({ id: section.id, label: section.label, subtotalCents: section.subtotalCents, runningTotalCents: running += section.subtotalCents }));
  if (laborCents) steps.push({ id: LABOR_ID, label: 'Labor', subtotalCents: laborCents, runningTotalCents: running += laborCents });
  const breakdown = { version: COMPOSITE_SCHEMA_VERSION, source: 'composite', menuVersion: version, settingsVersion: settings.settingsVersion,
    sections: sections.map(({ completed, ...section }) => section), lines: detail, purchaseList: purchaseList(detail), ...(labor ? { labor } : {}), totalCents };
  return { compositePricing: selection, menuVersion: version, settingsVersion: settings.settingsVersion, lineItems, storedLineItems, breakdown, steps, labor, junkOnly: junk, totalCents, approval: approvalOf(detail, prices, state, labor, { requireLabor }) };
}

/** The customer-facing scope of a priced builder quote (priceCompositeQuote's result, or {breakdown, labor}): each step's
 * items, then "Labor" (one word, never the man-hours: D-LABOR-TEXT). A junk-only quote (D-JUNK) says it is junk removal
 * only, so its scope never reads as a garage cleanout it does not price. The quote builder's sent quotes write the same
 * text (crew/quote-draft.js builderScope), and a signed walkthrough builder quote saves it as estimate.scope
 * (walkthrough-handoff.js): the customer signs and reads exactly the priced lines. */
export function compositeScope(priced) {
  const lines = Array.isArray(priced?.breakdown?.lines) ? priced.breakdown.lines.filter(plain) : [];
  const names = section => lines.filter(line => line.section === section).map(line => line.qty !== 1 ? `${line.name} × ${line.qty}` : line.name);
  if (junkOnly(lines)) return `Junk removal only: ${names('removal').join('; ')}. Loading, hauling and disposal; no sorting, organizing or reset.`.slice(0, 1600);
  const parts = (Array.isArray(priced?.breakdown?.sections) ? priced.breakdown.sections : []).map(section => names(section.id).length ? `${section.label}: ${names(section.id).join('; ')}` : '').filter(Boolean);
  if (typeof (priced?.labor ?? priced?.breakdown?.labor)?.manHours === 'number') parts.push('Labor');
  return `${parts.join('. ')}.`.slice(0, 1600);
}

// What the crew buys or grabs: one row per product, with packs, units and the public product page. No cost.
function purchaseList(lines) {
  return lines.filter(line => line.sku).map(line => ({ sku: line.sku, name: line.name, retailer: line.retailer, section: line.section, group: line.group, packs: line.qty, unitsPerPack: line.unitsPerPack,
    units: line.qty * line.unitsPerPack, productUrl: line.productUrl, perOrderPackLimit: line.perOrderPackLimit, overOrderLimit: line.perOrderPackLimit !== null && line.qty > line.perOrderPackLimit, fitWarnings: line.fitWarnings }));
}

// labor: the quote's priced labor (breakdown.labor), undefined for a quote saved before the Labor line existed, which
// is refused unless requireLabor is false (a job the customer already signed that way: it keeps the earlier rules) or the
// quote is junk-only (D-JUNK: it has no Labor line; an unsent one that still has one is saved again first).
// signed: the breakdown is a signed job's, whose labor keeps the rate and line it was signed at (laborBlock).
function approvalOf(lines, prices, state, labor, { requireLabor = true, signed = false } = {}) {
  const junk = junkOnly(lines);
  const blocked = lines.filter(line => {
    const price = prices.get(line.id);
    return !price || !price.approved || price.unitCents !== line.unitCents;
  }).map(line => {
    const price = prices.get(line.id);
    return { id: line.id, name: line.name, unitCents: line.unitCents,
      reason: !price ? `${line.name} is no longer on the pricing menu. Rebuild the quote before sending.`
        : price.approved ? `The owner approved ${money(price.unitCents)} for ${line.name}, but this quote has ${money(line.unitCents)}. Save the quote again to use the approved price.`
          : `${line.name}: ${price.reason.charAt(0).toLowerCase()}${price.reason.slice(1)}` };
  });
  const laborRow = laborBlock(labor === null ? undefined : labor, state, { required: requireLabor && !junk, signed, junk });
  if (laborRow) blocked.push(laborRow);
  // Installation is billed through the Labor line. A quote without one (saved before it existed) waits for the owner's
  // answer; a quote with one waits only for goods its estimate has no install time for (installNotEstimated, every good
  // when the breakdown has no estimate), until the estimator set the man-hours by hand or the owner answers. A Labor line
  // still waiting for its man-hours is blocked by its own reason above.
  if (lines.some(line => line.sku) && !installationIncluded(state)) {
    if (labor === undefined || labor === null) blocked.push({ ...INSTALLATION_BLOCK });
    else if (labor?.adjusted !== true && validManHours(labor?.manHours)) {
      const goods = [...new Map(lines.filter(line => line.sku).map(line => [line.id, { id: line.id, name: line.name, packs: line.qty }])).values()];
      const missing = plain(labor?.estimate) ? (Array.isArray(labor.estimate.installNotEstimated) ? labor.estimate.installNotEstimated.filter(row => plain(row) && typeof row.name === 'string') : goods) : goods;
      if (missing.length) blocked.push(installTimeBlock(missing));
    }
  }
  return { ready: blocked.length === 0, blocked };
}

/** Send-time check of a saved breakdown against today's menu, settings, approvals and labor rate: {ready, blocked}.
 * signed (a job the customer already signed, releaseGate): a breakdown without labor is judged by the earlier rules,
 * and its labor keeps the (then approved) rate it was signed at. */
export function compositeApproval(breakdown, state, { signed = false, requireLabor = !signed } = {}) {
  if (!plain(breakdown) || breakdown.source !== 'composite' || !Array.isArray(breakdown.lines)) return { ready: false, blocked: [{ id: null, name: 'This quote', unitCents: null, reason: 'The saved builder breakdown is missing. Rebuild the quote before sending.' }] };
  return approvalOf(breakdown.lines, menuPrices(state), state, breakdown.labor, { requireLabor, signed });
}

/** The message and details a refused send carries: the reasons, in quote order, at most 8 named. */
export function approvalRefusal(approval) {
  const names = approval.blocked.map(line => line.name);
  const listed = names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
  return fail('prices_unapproved', `This quote has ${names.length} price${names.length === 1 ? '' : 's'} the owner has not approved: ${listed}. It stays saved as a draft and can be sent once the owner approves ${names.length === 1 ? 'it' : 'them'} in Hub > Catalog & pricing.`, 409,
    { unapproved: approval.blocked.map(({ id, name, unitCents, reason }) => ({ id, name, unitCents, reason })) });
}

/** The builder step a garage-catalog product belongs to (the Hub catalog quote): shelving or extra storage. */
export const sectionOfCatalogCategory = category => category === 'shelving' ? 'shelving' : 'storage';

// The public product page of a garage-catalog item (its first https source) and, for a Home Depot page, the internet
// SKU the page URL ends with. Catalog quotes have no pack data: an item priced 'each' is one unit per pack.
function catalogProduct(item) {
  const source = (Array.isArray(item?.sources) ? item.sources : []).find(entry => typeof entry?.url === 'string' && /^https:\/\//.test(entry.url));
  if (!source) return null;
  let sku = null;
  try { sku = source.retailer === 'The Home Depot' ? /\/(\d{6,12})\/?$/.exec(new URL(source.url).pathname)?.[1] || null : null; } catch { sku = null; }
  return { productUrl: source.url, retailer: typeof source.retailer === 'string' ? source.retailer.slice(0, 80) : null, sku, unitsPerPack: item.priceUnit === 'each' ? 1 : null };
}

/**
 * The structured breakdown of any saved quote job, for the job breakdown and the purchase / grab list:
 *   a builder quote returns its saved breakdown (source 'composite');
 *   any other quote is derived from estimate.lineItems (source 'line_items'): catalog products by the garage
 *   catalog category, product page and (Home Depot) SKU when {catalog} resolves them, walkthrough lines by their
 *   id. Customer-supplied products are not on the purchase list.
 * Lines: {id, lineItemId, section, category, group, menuId, sku, retailer, name, qty, unit, unitsPerPack, unitCents,
 *   totalCents, approved, productUrl, photoUrl, perOrderPackLimit, fitWarnings}. Never a cost.
 */
export function quoteBreakdown(job, { catalog = null } = {}) {
  const saved = job?.quoteDraft?.breakdown;
  if (plain(saved) && saved.source === 'composite' && Array.isArray(saved.lines)) return saved;
  const items = Array.isArray(job?.estimate?.lineItems) ? normalizeLineItems(job.estimate.lineItems).lineItems.filter(included) : [];
  if (!items.length) return null;
  const catalogItems = new Map((Array.isArray(catalog?.items) ? catalog.items : []).filter(item => plain(item) && typeof item.id === 'string').map(item => [item.id, item]));
  // A line nothing places (a minimum charge, an adjustment, a cleaning service) is a 'service' line in the step of the
  // line before it, or removal / cleanout when it comes first.
  let previous = 'removal';
  const sectionOf = line => {
    const category = line.catalog?.itemId ? catalogItems.get(line.catalog.itemId)?.category : undefined;
    if (category && category !== 'services') return { section: sectionOfCatalogCategory(category), category: sectionOfCatalogCategory(category) };
    if (category === 'services') return { section: 'removal', category: 'service' };
    if (/^(?:cleanout|special-|access-|removal-)/.test(line.id)) return { section: 'removal', category: 'removal' };
    if (/^(?:deep-clean|pressure-wash|pest-waste|mouse-trapping|service-)/.test(line.id)) return { section: 'removal', category: 'service' };
    if (/^shelving/.test(line.id)) return { section: 'shelving', category: 'shelving' };
    if (/^(?:totes|storage-)/.test(line.id) || line.kind === 'product') return { section: 'storage', category: 'storage' };
    return { section: previous, category: 'service' };
  };
  const purchases = [];
  const lines = items.map(line => {
    const placed = sectionOf(line); previous = placed.section;
    const item = line.catalog?.itemId ? catalogItems.get(line.catalog.itemId) : null, product = line.kind === 'product' && item?.kind === 'product' ? catalogProduct(item) : null;
    const row = { id: line.id, lineItemId: line.id, ...placed, group: null, menuId: null, sku: product?.sku || null, retailer: product?.retailer || null, name: line.name, qty: line.quantity, unit: line.kind === 'product' ? 'each' : 'job', unitsPerPack: product?.unitsPerPack ?? null,
      unitCents: line.unitCents, totalCents: line.totalCents, approved: null, productUrl: product?.productUrl || null, photoUrl: null, perOrderPackLimit: null, fitWarnings: null };
    if (product && line.customerSupplied !== true) purchases.push({ sku: row.sku, name: row.name, retailer: row.retailer, section: row.section, group: null, packs: row.qty, unitsPerPack: row.unitsPerPack,
      units: row.unitsPerPack ? row.qty * row.unitsPerPack : null, productUrl: row.productUrl, perOrderPackLimit: null, overOrderLimit: false, fitWarnings: null });
    return row;
  });
  const sections = BUILDER_STEPS.map(id => ({ id, label: SECTION_LABEL.get(id), subtotalCents: lines.filter(line => line.section === id).reduce((sum, line) => sum + (line.totalCents || 0), 0), lineIds: lines.filter(line => line.section === id).map(line => line.id) }));
  return { version: COMPOSITE_SCHEMA_VERSION, source: 'line_items', menuVersion: null, settingsVersion: job?.estimate?.pricingSettingsVersion || null, sections, lines, purchaseList: purchases, totalCents: lines.reduce((sum, line) => sum + (line.totalCents || 0), 0) };
}

/** A menu document from its JSON text, validated and frozen (the store parses the bundled one once per isolate). */
export const parsePricingMenu = json => freeze(validatePricingMenu(JSON.parse(json)));
export const groupLabel = id => GROUP_LABEL.get(id) || null;
// The bundled pricing menu (functions/_data/pricing-menu.json via its generated module), parsed and validated once
// per isolate. tests/composite-quote.test.mjs validates the shipped menu.
let bundled = null;
export const bundledPricingMenu = () => bundled || (bundled = parsePricingMenu(PRICING_MENU_JSON));

/**
 * The garage-catalog category (functions/_data/garage-catalog.json) a builder estimate line stands for, so funnel
 * metrics (funnel-dimensions.js lineItemCatalogCategories) place builder quotes like catalog quotes: the shelving
 * goods line is 'shelving', the extra-storage goods line 'wall-systems' (the catalog's general garage-storage
 * category; every storage category maps to the same service line), a cleaning base or cleaning add-on 'services'.
 * Junk loads, special items and access charges name no catalog category. Anything else is null.
 */
export function compositeCatalogCategory(itemId, menu = null) {
  if (itemId === GOODS_LINES.shelving.catalogId) return 'shelving';
  if (itemId === GOODS_LINES.storage.catalogId) return 'wall-systems';
  if (typeof itemId !== 'string' || !SERVICE_ID.test(itemId)) return null;
  let services;
  try { services = (menu || bundledPricingMenu()).services; } catch { return null; }
  const service = services.find(entry => entry.id === itemId);
  return service && ['cleaning-base', 'cleaning'].includes(service.group) ? 'services' : null;
}
