import { goodsMarkupOf, roundCents, validatePricingSettings } from './catalog.js';
import { estimateTotals, included, normalizeLineItems } from './quote-model.js';
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
 * given for (menuItemIdentity): a re-import that renames or re-maps an item id puts it back into draft. Goods are
 * priced without installation, so a quote with goods also waits for the owner to confirm that installation is
 * included in the goods price: in the pricing settings (goodsInstallationIncluded, Hub > Catalog & pricing > Pricing,
 * only while CATALOG_QUOTES_ENABLED is on) or with the menu approvals (approvals.goodsInstallationIncluded, the owner's
 * menu.approve on Menu prices, which the builder flag alone allows). Either confirmation counts. Draft prices may be
 * saved on an unsent draft, never sent: quote-draft.js re-checks compositeApproval() at send preview and send.
 *
 * The customer-facing estimate keeps at most 12 charged lines (the portal limit): special-handling items, access
 * charges and each goods step (shelving, extra storage) roll up into one line each; the breakdown keeps every item.
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
const GARAGE_SIZES = ['1', '2', '3', 'other'];
// The customer portal and quote drafts charge at most 12 lines (money-service MAX_ESTIMATE_LINES, quote-draft
// MAX_INCLUDED_LINES); special-handling items, access charges and each goods step roll up into one line each, so
// the largest removal step (9 lines) plus both goods lines always fits.
export const MAX_CHARGED_LINES = 12;
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

/** Approvals as stored in pricingMenuApprovals/current: {items: {[id]: {unitCents, identity, ...}}, revision}. */
export function validateMenuApprovals(value) {
  if (value === null || value === undefined) return { items: {}, revision: null };
  if (!plain(value) || !plain(value.items) || !(value.revision === null || typeof value.revision === 'string') || !(value.goodsInstallationIncluded === undefined || typeof value.goodsInstallationIncluded === 'boolean')) throw fail('approvals_invalid', 'The saved price approvals failed verification. Nothing was priced; the owner must re-save them.', 503);
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

// Goods are priced at cost x goodsMarkup with no installation line. Until the owner confirms that installation is
// included in that price, a quote with goods is saved but never sent. The confirmation is the pricing settings'
// goodsInstallationIncluded (the Pricing tab, which needs CATALOG_QUOTES_ENABLED) or the menu approvals' (Menu prices,
// which the quote builder flag alone opens): with only the builder on, the settings cannot be saved at all.
const installationIncluded = state => state?.settings?.goodsInstallationIncluded === true || state?.approvals?.goodsInstallationIncluded === true;
const INSTALLATION_BLOCK = Object.freeze({ id: INSTALLATION_ID, name: 'Shelving and storage installation', unitCents: null,
  reason: 'Shelving and storage installation is not priced: goods sell at public retail × the goods markup only, and the owner has not confirmed in Hub > Catalog & pricing (Menu prices) that installation is included in that price.' });

/** The builder's menu for one viewer. internal (owner/manager) adds the goods cost basis, the multiplier and the
 * approvals revision the owner's bulk approval needs; nobody else sees a cost. */
export function builderMenu(state, { internal = false, canApprove = false } = {}) {
  const prices = menuPrices(state), { menu, settings } = state, approvals = validateMenuApprovals(state.approvals);
  const status = id => { const price = prices.get(id); return { unitCents: price.unitCents, approved: price.approved, source: price.source, reason: price.reason }; };
  return {
    menuVersion: menu.menuVersion, settingsVersion: settings.settingsVersion, evidenceDate: menu.generatedOn,
    steps: BUILDER_STEPS, sections: BUILDER_SECTIONS, maxChargedLines: MAX_CHARGED_LINES,
    services: menu.services.map(service => ({ id: service.id, menuId: service.menuId, section: service.section, category: service.category, group: service.group, name: service.name, unit: service.unit,
      ...(service.garageSize ? { garageSize: service.garageSize } : {}), ...(service.basis.kind === 'junk' ? { junkFraction: service.basis.fraction } : { walkthroughKey: service.basis.key }),
      ...(service.scopeNote ? { scopeNote: service.scopeNote } : {}), ...status(service.id) })),
    products: menu.products.map(product => ({ id: product.id, sku: product.sku, retailer: product.retailer, name: product.name, section: product.section, group: product.group,
      unitsPerPack: product.unitsPerPack, perOrderPackLimit: product.perOrderPackLimit, productUrl: product.productUrl, photoUrl: product.photoUrl, fitWarnings: product.fitWarnings,
      ...status(product.id), ...(internal ? { retailPerPackCents: product.retailPerPackCents, evidence: product.evidence } : {}) })),
    // installationConfirmed: the owner's own answer on Menu prices (menu.approve), present once it was given.
    ...(internal ? { internal: { goodsMarkup: goodsMarkupOf(settings).multiplier, goodsInstallationIncluded: installationIncluded(state), roundingRule: settings.roundingRule, approvalsRevision: approvals.revision,
      ...(typeof approvals.goodsInstallationIncluded === 'boolean' ? { installationConfirmed: approvals.goodsInstallationIncluded } : {}) } } : {}),
    // Every viewer learns whether goods can be sent at all (no amount is involved): the builder shows it per step.
    installation: installationIncluded(state) ? { included: true } : { included: false, reason: INSTALLATION_BLOCK.reason },
    viewer: { internal, canApprove: internal && canApprove },
  };
}

// The selection a browser sends: {menuVersion, settingsVersion, steps, removal, shelving, storage}.
const DESCRIPTOR_KEYS = ['menuVersion', 'settingsVersion', 'steps', 'removal', 'shelving', 'storage'];
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
  return out;
}

// The removal step's rules: one garage base, at most one partial load, a deep clean sized to the base, a pressure
// wash with a one-car base only, and bounded quantities.
function checkRemoval(entries, prices) {
  const byGroup = group => entries.filter(entry => prices.get(entry.id).item.group === group);
  const bases = byGroup('cleaning-base'), partial = byGroup('junk').filter(entry => prices.get(entry.id).item.basis.fraction < 1), full = byGroup('junk').filter(entry => prices.get(entry.id).item.basis.fraction === 1);
  if (bases.length > 1 || bases.some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Choose one garage cleaning base for the garage size.');
  if (partial.length > 1 || partial.some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Choose at most one partial load (a quarter, half or three-quarter truck).');
  if (full.some(entry => entry.quantity > MAX_FULL_LOADS)) throw fail('invalid_selection', `Quote at most ${MAX_FULL_LOADS} full truck loads.`);
  if (byGroup('special').some(entry => entry.quantity > MAX_SPECIAL)) throw fail('invalid_selection', `Quote at most ${MAX_SPECIAL} of one special-handling item.`);
  if ([...byGroup('access'), ...byGroup('cleaning')].some(entry => entry.quantity !== 1)) throw fail('invalid_selection', 'Access charges and cleaning add-ons are quoted once.');
  const size = bases.length ? prices.get(bases[0].id).item.garageSize : null;
  const sized = byGroup('cleaning').map(entry => prices.get(entry.id).item).filter(item => item.basis.table === 'deep_clean');
  if (sized.length > 1) throw fail('invalid_selection', 'Choose one deep clean, sized to the garage.');
  if (size && sized.some(item => item.garageSize !== size)) throw fail('invalid_selection', 'The deep clean must match the garage cleaning base size.');
  if (byGroup('cleaning').some(entry => prices.get(entry.id).item.basis.key === 'pressure_wash') && size !== '1') throw fail('invalid_selection', 'Pressure washing is quoted for a one-car garage cleaning base only.');
}

/**
 * Prices one builder selection. complete:true (a save) requires all three steps. Returns:
 *   compositePricing  the normalized selection (what a save stores and a revision re-sends)
 *   lineItems         the customer-facing quote-model lines (no cost split), in step order
 *   storedLineItems   the same lines with the internal goods cost split, for the Hub job only
 *   breakdown         the itemized, cost-free job breakdown by section (see quoteBreakdown)
 *   steps             [{id,label,subtotalCents,runningTotalCents}] for the completed steps
 *   approval          {ready, blocked:[{id,name,unitCents,reason}]}: ready false blocks sending
 */
export function priceCompositeQuote(state, descriptor, { complete = false } = {}) {
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
  checkRemoval(selection.removal, prices);
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
  if (model.filter(line => line.totalCents > 0).length > MAX_CHARGED_LINES) throw fail('too_many_lines', `A quote can charge at most ${MAX_CHARGED_LINES} lines so the customer portal shows every charge. Remove a removal item or split the work into two quotes.`, 400, { maxChargedLines: MAX_CHARGED_LINES });
  const stored = model.map(line => splits.has(line.id) ? { ...line, split: splits.get(line.id) } : line);
  let storedLineItems;
  try { storedLineItems = normalizeLineItems(stored, { strict: true }).lineItems; }
  catch (error) { throw fail('unavailable', `The builder quote could not be verified: ${error.message}`, 503); }
  const totals = estimateTotals(storedLineItems), totalCents = detail.reduce((sum, line) => sum + line.totalCents, 0);
  if (!totals.complete || totals.totalCents !== totalCents || totalCents <= 0 || storedLineItems.some(line => !included(line))) throw fail('unavailable', 'The builder quote total could not be verified. Keep the selections and retry.', 503);
  const lineItems = storedLineItems.map(({ split, durationMinutes, ...line }) => line);
  const sections = BUILDER_STEPS.map(id => ({ id, label: SECTION_LABEL.get(id), completed: selection.steps.includes(id), subtotalCents: detail.filter(line => line.section === id).reduce((sum, line) => sum + line.totalCents, 0), lineIds: detail.filter(line => line.section === id).map(line => line.id) }));
  let running = 0;
  const steps = sections.filter(section => section.completed).map(section => ({ id: section.id, label: section.label, subtotalCents: section.subtotalCents, runningTotalCents: running += section.subtotalCents }));
  const breakdown = { version: COMPOSITE_SCHEMA_VERSION, source: 'composite', menuVersion: version, settingsVersion: settings.settingsVersion,
    sections: sections.map(({ completed, ...section }) => section), lines: detail, purchaseList: purchaseList(detail), totalCents };
  return { compositePricing: selection, menuVersion: version, settingsVersion: settings.settingsVersion, lineItems, storedLineItems, breakdown, steps, totalCents, approval: approvalOf(detail, prices, state) };
}

// What the crew buys or grabs: one row per product, with packs, units and the public product page. No cost.
function purchaseList(lines) {
  return lines.filter(line => line.sku).map(line => ({ sku: line.sku, name: line.name, retailer: line.retailer, section: line.section, group: line.group, packs: line.qty, unitsPerPack: line.unitsPerPack,
    units: line.qty * line.unitsPerPack, productUrl: line.productUrl, perOrderPackLimit: line.perOrderPackLimit, overOrderLimit: line.perOrderPackLimit !== null && line.qty > line.perOrderPackLimit, fitWarnings: line.fitWarnings }));
}

function approvalOf(lines, prices, state) {
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
  if (lines.some(line => line.sku) && !installationIncluded(state)) blocked.push({ ...INSTALLATION_BLOCK });
  return { ready: blocked.length === 0, blocked };
}

/** Send-time check of a saved breakdown against today's menu, settings and approvals: {ready, blocked}. */
export function compositeApproval(breakdown, state) {
  if (!plain(breakdown) || breakdown.source !== 'composite' || !Array.isArray(breakdown.lines)) return { ready: false, blocked: [{ id: null, name: 'This quote', unitCents: null, reason: 'The saved builder breakdown is missing. Rebuild the quote before sending.' }] };
  return approvalOf(breakdown.lines, menuPrices(state), state);
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
