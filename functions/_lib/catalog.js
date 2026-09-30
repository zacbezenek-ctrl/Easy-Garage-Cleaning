import { addDays, denverToday, validDate } from './dispatch-time.js';

// Garage product catalog: strict schema validation, need/zone lookups, the price staleness
// flag and the sell-price engine. Pure: no I/O, and time is always injected.
// Money is integer cents. Rounding rule (settings.roundingRule): 'half_up_cent' rounds every
// fractional cent half up (0.5 cent -> 1 cent); 'ceil_cent' rounds any fraction up. Each component
// (labor, markup) is rounded once per unit (one priceUnit), and a line is always exactly the unit
// figures x quantity: the LI-CORE line-item contract (functions/_lib/quote-model.js).

export const CATALOG_SCHEMA_VERSION = 1;
export const PRODUCT_CATEGORIES = ['bikes', 'cabinets-workbenches', 'floors-lighting-extras', 'lawn-garden', 'overhead', 'shelving', 'small-items', 'sports-outdoor', 'wall-systems'];
export const CATALOG_CATEGORIES = [...PRODUCT_CATEGORIES, 'services'];
export const TIERS = ['good', 'better', 'best'];
export const AVAILABILITY = ['active', 'referral_only', 'hidden'];
export const INSTALL_REQUIREMENTS = ['wall-studs', 'ceiling-joists', 'none-freestanding', 'assembly-only', 'two-person-lift', 'electrical-outlet', 'level-floor', 'drywall-only-light-duty', 'electrician-required', 'concrete-anchors', 'masonry'];
// Verified: 'product_page' (read on the live product page) or 'search_snippet' (a search result tied to the product).
// Unverified: 'unconfirmed_snippet' (a price was seen but not tied to this product) or 'estimate'.
export const PRICE_EVIDENCE = ['product_page', 'search_snippet', 'unconfirmed_snippet', 'estimate', 'egc_price_list'];
const VERIFIED_EVIDENCE = ['product_page', 'search_snippet'];
export const AUDIT_STATUS = ['fixed_per_audit', 'fixed_per_self_review', 'reviewed_no_change', 'no_findings', 'self_reviewed_no_findings', 'legacy_service'];
export const COVERAGE = ['full', 'limited', 'referral_only', 'service'];
export const ROUNDING_RULES = ['half_up_cent', 'ceil_cent'];
export const GARAGE_SIZES = ['1', '2', '3', 'other'];
export const DEFAULT_STALE_DAYS = 90;
// Quantity, line total and per-unit minute limits match the LI-CORE line-item model.
const MAX_ITEM_CENTS = 10000000, MAX_QUANTITY = 10000, MAX_LINE_CENTS = 100000000, MAX_UNIT_MINUTES = 1440, MAX_MARKUP_PCT = 500;
const SPLIT_KEYS = ['productCents', 'laborCents', 'laborMinutes', 'markupCents', 'disposalCents'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const IMAGE_URL = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|ico)(?:[?#][^\s"'<>]*)?(?![a-z0-9])/i;
const IMAGE_HOST = /(?:^|[/.@])(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|i5\.walmartimages\.com|images\.thdstatic\.com|mobileimages\.lowes\.com|cdn\.shopify\.com)(?:[/:?#]|$)/i;
const IMAGE_KEY = /^(?:image|images|imageurl|photo|photos|photourl|thumbnail|thumb|img|picture)$/i;
const SETTINGS_KEYS = ['schemaVersion', 'settingsVersion', 'mustSetBeforeCustomerUse', 'currency', 'laborRateCents', 'markupPct', 'minimumJobCents', 'includeDisposal', 'disposalCentsPerItem', 'depositPct', 'roundingRule'];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `catalog_${code}`, status, ...(details ? { details } : {}) });
const invalid = (path, reason) => fail('invalid', `Catalog is invalid at ${path}: ${reason}`, 400, { path, reason });
const settingsInvalid = (path, reason) => fail('settings_invalid', `Pricing settings are invalid at ${path}: ${reason}`, 400, { path, reason });
const pricingInvalid = (path, reason) => fail('pricing_invalid', `Cannot price ${path}: ${reason}`, 400, { path, reason });

function shape(value, path, required, optional = [], error = invalid) {
  if (!plain(value)) throw error(path, 'must be an object');
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw error(`${path}.${key}`, 'is not an allowed field');
  for (const key of required) if (!Object.hasOwn(value, key)) throw error(`${path}.${key}`, 'is required');
  return value;
}
function text(value, path, { max = 4000, nullable = false, min = 1 } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || value !== value.trim()) throw invalid(path, `must be ${nullable ? 'null or ' : ''}trimmed text of ${min} to ${max} characters`);
  return value;
}
function integer(value, path, min, max, error = invalid) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error(path, `must be an integer from ${min} to ${max}`);
  return value;
}
function flag(value, path, error = invalid) {
  if (typeof value !== 'boolean') throw error(path, 'must be true or false');
  return value;
}
function oneOf(value, path, allowed, error = invalid) {
  if (!allowed.includes(value)) throw error(path, `must be one of ${allowed.join(', ')}`);
  return value;
}
function dateText(value, path, notAfter) {
  if (!validDate(value)) throw invalid(path, 'must be a YYYY-MM-DD date');
  if (notAfter && value > notAfter) throw invalid(path, `must not be after ${notAfter}`);
  return value;
}
function list(value, path, check, { min = 0, max = 500, unique = false } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid(path, `must be a list of ${min} to ${max} entries`);
  value.forEach((entry, index) => check(entry, `${path}[${index}]`));
  if (unique && new Set(value.map(entry => plain(entry) ? entry.id : entry)).size !== value.length) throw invalid(path, 'must not repeat entries');
  return value;
}
function percent(value, path, error) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MARKUP_PCT || Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) throw error(path, `must be a percentage from 0 to ${MAX_MARKUP_PCT} with at most 2 decimals`);
  return Math.round(value * 100);
}
function noImages(value, path) {
  if (typeof value === 'string') { if (IMAGE_URL.test(value) || IMAGE_HOST.test(value)) throw invalid(path, 'must not contain an image URL'); return; }
  if (Array.isArray(value)) return value.forEach((entry, index) => noImages(entry, `${path}[${index}]`));
  if (plain(value)) for (const [key, entry] of Object.entries(value)) {
    if (IMAGE_KEY.test(key)) throw invalid(`${path}.${key}`, 'image fields are not allowed');
    noImages(entry, `${path}.${key}`);
  }
}
// A source counts as a price observation when it quotes a dollar amount and is not a "not observed" note.
const pricedSource = source => /\$\s?\d/.test(source.observedPrice) && !/^(?:price\s+)?not\s/i.test(source.observedPrice);

function source(value, path, kind, generatedOn) {
  shape(value, path, ['retailer', 'observedPrice', 'checkedOn'], ['url', 'reference']);
  if ((value.url === undefined) === (value.reference === undefined)) throw invalid(path, 'needs exactly one of url or reference');
  if (value.url !== undefined) {
    let url;
    try { url = new URL(text(value.url, `${path}.url`, { max: 600 })); } catch (error) { if (error.code === 'catalog_invalid') throw error; throw invalid(`${path}.url`, 'must be a valid URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /\s/.test(value.url)) throw invalid(`${path}.url`, 'must be a public https URL');
  } else {
    if (kind !== 'service') throw invalid(`${path}.reference`, 'repository references are only for EGC service items');
    if (!/^[a-z0-9][a-z0-9_./-]*\.[a-z]+#[A-Za-z]+$/.test(value.reference)) throw invalid(`${path}.reference`, 'must be a repository path with an anchor');
  }
  text(value.retailer, `${path}.retailer`, { max: 200 });
  text(value.observedPrice, `${path}.observedPrice`, { max: 600 });
  dateText(value.checkedOn, `${path}.checkedOn`, generatedOn);
}

function item(value, path, context) {
  const kind = plain(value) ? value.kind : undefined;
  const common = ['id', 'kind', 'category', 'subcategory', 'needs', 'zones', 'tier', 'availability', 'name', 'priceUnit', 'installRequirements', 'installMinutes', 'crewSize', 'haulAwayApplicable', 'priceVerified', 'priceVerifiedAt', 'priceEvidence', 'verificationNote', 'sources', 'safetyNotes', 'auditStatus', 'auditActions'];
  if (kind === 'product') shape(value, path, [...common, 'brand', 'model', 'genericSpec', 'dimensions', 'weightCapacity', 'requires', 'retailPriceLowCents', 'retailPriceHighCents', 'pros', 'cons', 'bestFor', 'installNotes'], ['sqFtPerUnit']);
  else if (kind === 'service') shape(value, path, [...common, 'description', 'fixedPriceCents', 'legacy']);
  else throw invalid(`${path}.kind`, 'must be product or service');
  if (typeof value.id !== 'string' || !SLUG.test(value.id)) throw invalid(`${path}.id`, 'must be a lowercase slug');
  const category = context.categories.get(value.category);
  if (!category) throw invalid(`${path}.category`, 'is not a known category');
  if (category.kind !== kind) throw invalid(`${path}.category`, `is a ${category.kind} category`);
  text(value.subcategory, `${path}.subcategory`, { max: 120 });
  list(value.needs, `${path}.needs`, (need, at) => { if (!context.needs.has(need)) throw invalid(at, 'is not a known need'); }, { min: 1, max: 8, unique: true });
  list(value.zones, `${path}.zones`, (zone, at) => { if (!context.zones.has(zone)) throw invalid(at, 'is not a known zone'); }, { min: 1, max: 9, unique: true });
  if (kind === 'product' || value.tier !== null) oneOf(value.tier, `${path}.tier`, TIERS);
  oneOf(value.availability, `${path}.availability`, AVAILABILITY);
  text(value.name, `${path}.name`, { max: 160 });
  text(value.priceUnit, `${path}.priceUnit`, { max: 120 });
  if (/not verified|typical range|estimate/i.test(value.priceUnit)) throw invalid(`${path}.priceUnit`, 'must describe the unit only; put verification text in verificationNote');
  list(value.installRequirements, `${path}.installRequirements`, (entry, at) => oneOf(entry, at, INSTALL_REQUIREMENTS), { max: INSTALL_REQUIREMENTS.length, unique: true });
  integer(value.installMinutes, `${path}.installMinutes`, 0, MAX_UNIT_MINUTES);
  integer(value.crewSize, `${path}.crewSize`, 1, 4);
  if (value.installRequirements.includes('two-person-lift') && value.crewSize < 2) throw invalid(`${path}.crewSize`, 'must be at least 2 when a two-person lift is required');
  if (kind === 'service' && value.crewSize !== 2) throw invalid(`${path}.crewSize`, 'must be 2: legacy walkthrough minutes are calibrated to a 2-person crew');
  flag(value.haulAwayApplicable, `${path}.haulAwayApplicable`);
  if (value.availability === 'referral_only' && (value.installMinutes !== 0 || value.haulAwayApplicable)) throw invalid(`${path}.availability`, 'referral-only items carry no EGC install minutes or haul-away');
  flag(value.priceVerified, `${path}.priceVerified`);
  oneOf(value.priceEvidence, `${path}.priceEvidence`, kind === 'service' ? ['egc_price_list'] : PRICE_EVIDENCE.filter(entry => entry !== 'egc_price_list'));
  list(value.sources, `${path}.sources`, (entry, at) => source(entry, at, kind, context.generatedOn), { max: 12 });
  const urls = value.sources.map(entry => entry.url || entry.reference);
  if (new Set(urls).size !== urls.length) throw invalid(`${path}.sources`, 'must not repeat a URL');
  if (value.priceVerified) {
    if (!value.sources.length) throw invalid(`${path}.sources`, 'a verified price needs at least one source');
    if (kind === 'product' && !VERIFIED_EVIDENCE.includes(value.priceEvidence)) throw invalid(`${path}.priceEvidence`, 'does not match a verified price');
    const latest = value.sources.filter(entry => kind === 'service' || pricedSource(entry)).map(entry => entry.checkedOn).sort().at(-1);
    if (!latest) throw invalid(`${path}.sources`, 'a verified price needs a source with an observed price');
    dateText(value.priceVerifiedAt, `${path}.priceVerifiedAt`, context.generatedOn);
    if (value.priceVerifiedAt !== latest) throw invalid(`${path}.priceVerifiedAt`, `must equal the latest priced source checkedOn (${latest})`);
  } else {
    if (value.priceVerifiedAt !== null) throw invalid(`${path}.priceVerifiedAt`, 'must be null when the price is not verified');
    if (VERIFIED_EVIDENCE.includes(value.priceEvidence) || kind === 'service') throw invalid(`${path}.priceEvidence`, 'does not match an unverified price');
    text(value.verificationNote, `${path}.verificationNote`, { max: 2000 });
  }
  if (value.priceVerified) text(value.verificationNote, `${path}.verificationNote`, { max: 2000, nullable: true });
  text(value.safetyNotes, `${path}.safetyNotes`, { max: 2000, min: 40 });
  if ((value.installRequirements.includes('ceiling-joists') || value.installRequirements.includes('two-person-lift')) && (value.safetyNotes.length < 80 || !/joist|truss|stud|anchor|lag|two people|two-person|2-person/i.test(value.safetyNotes))) throw invalid(`${path}.safetyNotes`, 'overhead and heavy items need specific mounting or lifting safety notes');
  oneOf(value.auditStatus, `${path}.auditStatus`, AUDIT_STATUS);
  if ((kind === 'service') !== (value.auditStatus === 'legacy_service')) throw invalid(`${path}.auditStatus`, 'legacy_service is only for EGC service items');
  list(value.auditActions, `${path}.auditActions`, (entry, at) => text(entry, at, { max: 600 }), { max: 40 });
  if (kind === 'product') {
    for (const key of ['brand', 'genericSpec', 'bestFor']) text(value[key], `${path}.${key}`, { max: 600 });
    for (const key of ['model', 'dimensions', 'weightCapacity', 'requires', 'installNotes']) text(value[key], `${path}.${key}`, { max: 1000, nullable: true });
    integer(value.retailPriceLowCents, `${path}.retailPriceLowCents`, 1, MAX_ITEM_CENTS);
    integer(value.retailPriceHighCents, `${path}.retailPriceHighCents`, value.retailPriceLowCents, MAX_ITEM_CENTS);
    if (value.sqFtPerUnit !== undefined && (typeof value.sqFtPerUnit !== 'number' || !(value.sqFtPerUnit > 0) || value.sqFtPerUnit > 10000)) throw invalid(`${path}.sqFtPerUnit`, 'must be a positive area');
    for (const key of ['pros', 'cons']) list(value[key], `${path}.${key}`, (entry, at) => text(entry, at, { max: 400 }), { max: 12 });
  } else {
    text(value.description, `${path}.description`, { max: 600 });
    integer(value.fixedPriceCents, `${path}.fixedPriceCents`, 1, MAX_ITEM_CENTS);
    const legacy = shape(value.legacy, `${path}.legacy`, ['condition', 'amountDollars', 'appliedBeforeRounding', 'jobMinutes'], ['finishId', 'hazard', 'shelfType', 'garageSizes']);
    text(legacy.condition, `${path}.legacy.condition`, { max: 400 });
    if (typeof legacy.amountDollars !== 'number' || Math.round(legacy.amountDollars * 100) !== value.fixedPriceCents) throw invalid(`${path}.legacy.amountDollars`, 'must equal fixedPriceCents in dollars');
    flag(legacy.appliedBeforeRounding, `${path}.legacy.appliedBeforeRounding`);
    integer(legacy.jobMinutes, `${path}.legacy.jobMinutes`, 0, 600);
    if (value.installMinutes !== legacy.jobMinutes * 2) throw invalid(`${path}.installMinutes`, 'must be the legacy 2-person job minutes times 2 (person-minutes)');
    for (const key of ['finishId', 'hazard', 'shelfType']) if (legacy[key] !== undefined) text(legacy[key], `${path}.legacy.${key}`, { max: 60 });
    if (legacy.garageSizes !== undefined) list(legacy.garageSizes, `${path}.legacy.garageSizes`, (size, at) => oneOf(size, at, GARAGE_SIZES), { min: 1, max: GARAGE_SIZES.length, unique: true });
  }
}

function coverageOf(catalog, need) {
  const members = catalog.items.filter(entry => entry.needs.includes(need));
  const active = members.filter(entry => entry.availability === 'active'), tiers = new Set(active.map(entry => entry.tier).filter(Boolean));
  if (members.length && members.every(entry => entry.kind === 'service')) return { coverage: 'service', active: active.length, tiers: tiers.size };
  if (!active.length && members.some(entry => entry.availability === 'referral_only')) return { coverage: 'referral_only', active: 0, tiers: 0 };
  return { coverage: active.length >= 3 && tiers.size >= 2 ? 'full' : 'limited', active: active.length, tiers: tiers.size };
}

export function validateCatalog(catalog) {
  shape(catalog, 'catalog', ['schemaVersion', 'catalogVersion', 'generatedOn', 'currency', 'staleAfterDays', 'priceBasis', 'zones', 'categories', 'needs', 'auditLog', 'items']);
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) throw invalid('catalog.schemaVersion', `must be ${CATALOG_SCHEMA_VERSION}`);
  if (typeof catalog.catalogVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(catalog.catalogVersion) || !validDate(catalog.catalogVersion.slice(0, 10))) throw invalid('catalog.catalogVersion', 'must look like YYYY-MM-DD.N');
  dateText(catalog.generatedOn, 'catalog.generatedOn');
  if (catalog.catalogVersion.slice(0, 10) !== catalog.generatedOn) throw invalid('catalog.generatedOn', 'must be the date in catalogVersion');
  if (catalog.currency !== 'USD') throw invalid('catalog.currency', 'must be USD');
  integer(catalog.staleAfterDays, 'catalog.staleAfterDays', 1, 365);
  text(catalog.priceBasis, 'catalog.priceBasis', { max: 1000 });
  noImages(catalog, 'catalog');
  list(catalog.zones, 'catalog.zones', (zone, at) => { shape(zone, at, ['id', 'label']); if (!SLUG.test(zone.id)) throw invalid(`${at}.id`, 'must be a lowercase slug'); text(zone.label, `${at}.label`, { max: 80 }); }, { min: 1, max: 30, unique: true });
  list(catalog.categories, 'catalog.categories', (category, at) => { shape(category, at, ['id', 'label', 'kind']); oneOf(category.id, `${at}.id`, CATALOG_CATEGORIES); text(category.label, `${at}.label`, { max: 80 }); oneOf(category.kind, `${at}.kind`, [category.id === 'services' ? 'service' : 'product']); }, { min: CATALOG_CATEGORIES.length, max: CATALOG_CATEGORIES.length, unique: true });
  const zones = new Set(catalog.zones.map(zone => zone.id));
  list(catalog.needs, 'catalog.needs', (need, at) => {
    shape(need, at, ['id', 'label', 'category', 'coverage', 'coverageNote', 'relatedNeeds']);
    if (!SLUG.test(need.id)) throw invalid(`${at}.id`, 'must be a lowercase slug');
    if (zones.has(need.id)) throw invalid(`${at}.id`, 'must not reuse a zone id');
    text(need.label, `${at}.label`, { max: 120 });
    oneOf(need.category, `${at}.category`, CATALOG_CATEGORIES);
    oneOf(need.coverage, `${at}.coverage`, COVERAGE);
    text(need.coverageNote, `${at}.coverageNote`, { max: 600, nullable: need.coverage === 'full' || need.coverage === 'service' });
  }, { min: 1, max: 300, unique: true });
  const needIds = new Set(catalog.needs.map(need => need.id));
  catalog.needs.forEach((need, index) => list(need.relatedNeeds, `catalog.needs[${index}].relatedNeeds`, (related, at) => { if (!needIds.has(related) || related === need.id) throw invalid(at, 'must be another known need'); }, { max: 10, unique: true }));
  const context = { categories: new Map(catalog.categories.map(category => [category.id, category])), needs: needIds, zones, generatedOn: catalog.generatedOn };
  list(catalog.items, 'catalog.items', (entry, at) => item(entry, at, context), { min: 1, max: 5000, unique: true });
  catalog.needs.forEach((need, index) => {
    const found = coverageOf(catalog, need.id);
    if (!catalog.items.some(entry => entry.needs.includes(need.id))) throw invalid(`catalog.needs[${index}]`, 'has no items');
    if (found.coverage !== need.coverage) throw invalid(`catalog.needs[${index}].coverage`, `claims ${need.coverage} but the items give ${found.coverage} (${found.active} active options across ${found.tiers} tiers)`);
  });
  const log = shape(catalog.auditLog, 'catalog.auditLog', ['method', 'auditedCategories', 'selfReviewedCategories', 'findingsReviewed', 'researchItems', 'publishedItems', 'legacyServiceItems', 'counts', 'itemsByFix', 'normalization', 'removedItems'], ['normalizationItems']);
  text(log.method, 'catalog.auditLog.method', { max: 2000 });
  for (const key of ['auditedCategories', 'selfReviewedCategories']) list(log[key], `catalog.auditLog.${key}`, (category, at) => oneOf(category, at, PRODUCT_CATEGORIES), { unique: true, max: PRODUCT_CATEGORIES.length });
  shape(log.findingsReviewed, 'catalog.auditLog.findingsReviewed', ['checks', 'redFlags', 'systemic']);
  for (const key of ['checks', 'redFlags', 'systemic']) integer(log.findingsReviewed[key], `catalog.auditLog.findingsReviewed.${key}`, 0, 10000);
  integer(log.researchItems, 'catalog.auditLog.researchItems', 0, 10000);
  if (log.publishedItems !== catalog.items.length) throw invalid('catalog.auditLog.publishedItems', 'must equal the number of items');
  if (log.legacyServiceItems !== catalog.items.filter(entry => entry.kind === 'service').length) throw invalid('catalog.auditLog.legacyServiceItems', 'must equal the number of service items');
  const removed = list(log.removedItems, 'catalog.auditLog.removedItems', (entry, at) => { shape(entry, at, ['id', 'reason'], ['mergedInto']); text(entry.reason, `${at}.reason`, { max: 600 }); if (catalog.items.some(other => other.id === entry.id)) throw invalid(`${at}.id`, 'is still published'); if (entry.mergedInto !== undefined && !catalog.items.some(other => other.id === entry.mergedInto)) throw invalid(`${at}.mergedInto`, 'is not a published item'); }, { unique: true });
  const known = new Set([...catalog.items.map(entry => entry.id), ...removed.map(entry => entry.id)]);
  if (!plain(log.counts) || !plain(log.itemsByFix) || !plain(log.normalization)) throw invalid('catalog.auditLog', 'counts, itemsByFix and normalization must be objects');
  if (Object.keys(log.counts).sort().join() !== Object.keys(log.itemsByFix).sort().join()) throw invalid('catalog.auditLog.counts', 'must have the same fix types as itemsByFix');
  for (const [type, ids] of Object.entries(log.itemsByFix)) {
    list(ids, `catalog.auditLog.itemsByFix.${type}`, (id, at) => { if (!known.has(id)) throw invalid(at, 'is not a catalog or removed item'); }, { unique: true, max: 5000 });
    if (log.counts[type] !== ids.length) throw invalid(`catalog.auditLog.counts.${type}`, 'must equal the number of items listed for it');
  }
  for (const [type, count] of Object.entries(log.normalization)) integer(count, `catalog.auditLog.normalization.${type}`, 0, 10000);
  if (log.normalizationItems !== undefined) {
    if (!plain(log.normalizationItems)) throw invalid('catalog.auditLog.normalizationItems', 'must be an object');
    for (const [type, ids] of Object.entries(log.normalizationItems)) {
      const at = `catalog.auditLog.normalizationItems.${type}`;
      if (!Object.hasOwn(log.normalization, type)) throw invalid(at, 'is not a normalization type');
      list(ids, at, (id, where) => { if (!known.has(id)) throw invalid(where, 'is not a catalog or removed item'); }, { unique: true, max: 5000 });
      if (ids.length !== log.normalization[type]) throw invalid(at, 'must list as many items as its normalization count');
    }
  }
  return catalog;
}

export function validatePricingSettings(settings) {
  shape(settings, 'settings', SETTINGS_KEYS, ['comments'], settingsInvalid);
  if (settings.schemaVersion !== 1) throw settingsInvalid('settings.schemaVersion', 'must be 1');
  if (typeof settings.settingsVersion !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(settings.settingsVersion)) throw settingsInvalid('settings.settingsVersion', 'must be a short version label');
  flag(settings.mustSetBeforeCustomerUse, 'settings.mustSetBeforeCustomerUse', settingsInvalid);
  if (settings.currency !== 'USD') throw settingsInvalid('settings.currency', 'must be USD');
  integer(settings.laborRateCents, 'settings.laborRateCents', 1, 100000, settingsInvalid);
  shape(settings.markupPct, 'settings.markupPct', ['default', 'byCategory'], [], settingsInvalid);
  percent(settings.markupPct.default, 'settings.markupPct.default', settingsInvalid);
  if (!plain(settings.markupPct.byCategory)) throw settingsInvalid('settings.markupPct.byCategory', 'must be an object');
  for (const [category, pct] of Object.entries(settings.markupPct.byCategory)) {
    if (!PRODUCT_CATEGORIES.includes(category)) throw settingsInvalid(`settings.markupPct.byCategory.${category}`, 'is not a product category');
    percent(pct, `settings.markupPct.byCategory.${category}`, settingsInvalid);
  }
  integer(settings.minimumJobCents, 'settings.minimumJobCents', 0, MAX_ITEM_CENTS, settingsInvalid);
  flag(settings.includeDisposal, 'settings.includeDisposal', settingsInvalid);
  integer(settings.disposalCentsPerItem, 'settings.disposalCentsPerItem', 0, 100000, settingsInvalid);
  if (typeof settings.depositPct !== 'number' || !Number.isFinite(settings.depositPct) || settings.depositPct < 0 || settings.depositPct > 100 || Math.abs(settings.depositPct * 100 - Math.round(settings.depositPct * 100)) > 1e-9) throw settingsInvalid('settings.depositPct', 'must be a percentage from 0 to 100 with at most 2 decimals');
  oneOf(settings.roundingRule, 'settings.roundingRule', ROUNDING_RULES, settingsInvalid);
  if (settings.comments !== undefined) {
    if (!plain(settings.comments)) throw settingsInvalid('settings.comments', 'must be an object');
    for (const [key, comment] of Object.entries(settings.comments)) {
      if (!SETTINGS_KEYS.includes(key)) throw settingsInvalid(`settings.comments.${key}`, 'is not a setting');
      if (typeof comment !== 'string' || !comment.trim() || comment.length > 2000) throw settingsInvalid(`settings.comments.${key}`, 'must be text');
    }
  }
  return settings;
}

// Placeholder settings (mustSetBeforeCustomerUse) may price internal estimates only.
export const settingsReadyForCustomers = settings => validatePricingSettings(settings).mustSetBeforeCustomerUse === false;

// Exact integer division of non-negative safe integers, following the settings rounding rule.
function roundCents(numerator, denominator, rule) {
  const n = BigInt(numerator), d = BigInt(denominator);
  return Number(rule === 'ceil_cent' ? (n + d - 1n) / d : (2n * n + d) / (2n * d));
}

// One unit (one priceUnit) of an active item: {productCents, laborCents, laborMinutes, markupCents, disposalCents, fixedCents}.
function unitPrice(item, settings, options, settingsValidated = false) {
  if (!settingsValidated) validatePricingSettings(settings);
  if (!plain(item) || typeof item.id !== 'string') throw pricingInvalid('item', 'is not a catalog item');
  const label = `item ${item.id}`;
  shape(options, `${label} options`, [], ['quantity', 'customerSupplied', 'productCostCents'], pricingInvalid);
  if (item.availability !== 'active') throw fail('item_not_quotable', `${item.name || item.id} is ${String(item.availability).replace('_', ' ')} and cannot be priced for a quote.`, 409, { itemId: item.id, availability: item.availability });
  const quantity = options.quantity === undefined ? 1 : integer(options.quantity, `${label} quantity`, 1, MAX_QUANTITY, pricingInvalid);
  const customerSupplied = options.customerSupplied === undefined ? false : flag(options.customerSupplied, `${label} customerSupplied`, pricingInvalid);
  const laborMinutes = integer(item.installMinutes, `${label} installMinutes`, 0, MAX_UNIT_MINUTES, pricingInvalid);
  let unit;
  if (item.kind === 'service') {
    if (customerSupplied || options.productCostCents !== undefined) throw pricingInvalid(label, 'a fixed-price service has no product cost to supply or override');
    unit = { productCents: 0, laborCents: 0, laborMinutes, markupCents: 0, disposalCents: 0, fixedCents: integer(item.fixedPriceCents, `${label} fixedPriceCents`, 1, MAX_ITEM_CENTS, pricingInvalid) };
  } else {
    if (item.kind !== 'product') throw pricingInvalid(`${label} kind`, 'must be product or service');
    if (!PRODUCT_CATEGORIES.includes(item.category)) throw pricingInvalid(`${label} category`, 'is not a product category');
    const unitCost = options.productCostCents === undefined ? integer(item.retailPriceHighCents, `${label} retailPriceHighCents`, 1, MAX_ITEM_CENTS, pricingInvalid) : integer(options.productCostCents, `${label} productCostCents`, 0, MAX_ITEM_CENTS, pricingInvalid);
    const productCents = customerSupplied ? 0 : unitCost;
    const markupBasisPoints = percent(settings.markupPct.byCategory[item.category] ?? settings.markupPct.default, 'settings.markupPct', settingsInvalid);
    unit = {
      productCents, laborCents: roundCents(laborMinutes * settings.laborRateCents, 60, settings.roundingRule), laborMinutes,
      markupCents: roundCents(productCents * markupBasisPoints, 10000, settings.roundingRule),
      disposalCents: settings.includeDisposal && item.haulAwayApplicable === true ? settings.disposalCentsPerItem : 0, fixedCents: 0,
    };
  }
  const unitCents = unit.productCents + unit.laborCents + unit.markupCents + unit.disposalCents + unit.fixedCents;
  if (unitCents * quantity > MAX_LINE_CENTS) throw pricingInvalid(`${label} quantity`, 'gives a line total over $1,000,000; split it into smaller lines');
  return { quantity, customerSupplied, unit, unitCents };
}

// The line breakdown: every figure is the unit figure x quantity. priceVerified and priceEvidence
// let a quote builder flag or block lines whose price is only an estimate.
export function computeSellPriceCents(item, settings, options = {}) {
  const { quantity, unit, unitCents } = unitPrice(item, settings, options);
  const line = Object.fromEntries(Object.entries(unit).map(([key, value]) => [key, value * quantity]));
  return { ...line, totalCents: unitCents * quantity, unitCents, quantity, priceVerified: item.priceVerified === true, priceEvidence: item.priceEvidence ?? null };
}

// The LI-CORE line fields for a catalog item. `split` and `durationMinutes` (person-minutes) describe
// ONE unit, so split sums to unitCents and totalCents = unitCents x quantity. A fixed-price service has
// no split. The quote builder adds id, group, tier and catalog: {itemId, version: catalog.catalogVersion}.
function catalogLineFromSettings(item, settings, options, settingsValidated) {
  const { quantity, customerSupplied, unit, unitCents } = unitPrice(item, settings, options, settingsValidated);
  const split = item.kind === 'service' ? null : Object.fromEntries(SPLIT_KEYS.map(key => [key, unit[key]]));
  return { kind: item.kind, name: item.name, quantity, unitCents, totalCents: unitCents * quantity, customerSupplied, split, durationMinutes: unit.laborMinutes };
}

export function catalogLine(item, settings, options = {}) {
  return catalogLineFromSettings(item, settings, options, false);
}

// Price a whole catalog after one strict settings validation. Copy the pricing inputs so an editor's later
// mutation cannot change the meaning of a validated batch. Single-line callers still validate every call.
export function catalogLinePricer(settings) {
  validatePricingSettings(settings);
  const pricing = {
    laborRateCents: settings.laborRateCents,
    markupPct: { default: settings.markupPct.default, byCategory: { ...settings.markupPct.byCategory } },
    includeDisposal: settings.includeDisposal,
    disposalCentsPerItem: settings.disposalCentsPerItem,
    roundingRule: settings.roundingRule,
  };
  return (item, options = {}) => catalogLineFromSettings(item, pricing, options, true);
}

// The minimum job charge applies to the whole quote, never to one line.
export function applyMinimum(totalCents, settings) {
  validatePricingSettings(settings);
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw pricingInvalid('quote total', 'must be a non-negative integer number of cents');
  return Math.max(totalCents, settings.minimumJobCents);
}

const TIER_ORDER = { good: 0, better: 1, best: 2 };
const priceKey = entry => entry.kind === 'service' ? entry.fixedPriceCents : entry.retailPriceHighCents;
// verifiedOnly drops estimate and unconfirmed prices; garageSize ('1', '2', '3' or 'other') drops
// services priced for another size (recommend() prices an unknown size as '2').
export function optionsForNeed(catalog, key, { includeReferral = false, verifiedOnly = false, garageSize } = {}) {
  if (!plain(catalog) || !Array.isArray(catalog.items) || !Array.isArray(catalog.needs) || !Array.isArray(catalog.zones)) throw fail('invalid', 'Catalog is not loaded.', 503);
  const byNeed = catalog.needs.some(need => need.id === key), byZone = !byNeed && catalog.zones.some(zone => zone.id === key);
  if (!byNeed && !byZone) throw fail('unknown_need', `No catalog need or zone is called ${String(key).slice(0, 80)}.`, 404, { key: String(key).slice(0, 80) });
  if (garageSize !== undefined && !GARAGE_SIZES.includes(garageSize)) throw fail('invalid_garage_size', `Garage size must be one of ${GARAGE_SIZES.join(', ')}.`, 400);
  return catalog.items
    .filter(entry => (byNeed ? entry.needs : entry.zones).includes(key) && (entry.availability === 'active' || includeReferral && entry.availability === 'referral_only'))
    .filter(entry => (!verifiedOnly || entry.priceVerified === true) && (garageSize === undefined || !entry.legacy?.garageSizes || entry.legacy.garageSizes.includes(garageSize)))
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3) || priceKey(a) - priceKey(b) || a.id.localeCompare(b.id));
}

function instant(now) {
  const value = now instanceof Date ? now : typeof now === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(now) ? new Date(now) : null;
  if (!value || !Number.isFinite(value.getTime())) throw fail('invalid_clock', 'A valid current time is required to check price freshness.', 400);
  return value;
}

// Items whose price was never verified or was verified more than `days` Denver calendar days ago
// (by default the catalog's own staleAfterDays).
export function staleItems(catalog, now, days = catalog?.staleAfterDays ?? DEFAULT_STALE_DAYS) {
  if (!plain(catalog) || !Array.isArray(catalog.items)) throw fail('invalid', 'Catalog is not loaded.', 503);
  integer(days, 'staleness window', 1, 3650, (path, reason) => fail('invalid_window', `The ${path} ${reason}.`, 400));
  const today = denverToday(instant(now)), cutoff = addDays(today, -days);
  const age = date => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000);
  return catalog.items
    .filter(entry => !entry.priceVerifiedAt || entry.priceVerifiedAt < cutoff)
    .map(entry => ({ id: entry.id, name: entry.name, category: entry.category, availability: entry.availability, priceVerifiedAt: entry.priceVerifiedAt || null, ageDays: entry.priceVerifiedAt ? age(entry.priceVerifiedAt) : null, reason: entry.priceVerifiedAt ? 'older_than_window' : 'never_verified' }))
    .sort((a, b) => (a.priceVerifiedAt || '').localeCompare(b.priceVerifiedAt || '') || a.id.localeCompare(b.id));
}
