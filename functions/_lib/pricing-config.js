import { sha256 } from '@noble/hashes/sha2.js';
import { AVAILABILITY, GARAGE_SIZES } from './catalog.js';
import { WALKTHROUGH_SERVICE_ITEMS } from '../_data/walkthrough-services.js';

// Server-only home of EGC's internal price tables: the walkthrough price tables and
// labor-minute model (crew/gameplan.html), the phone-quote table (the Employee Hub's
// on-call flow), the B2B partner rate card and the owner-only labor baseline, wages
// and targets. Browsers receive only the parts their role may see, from
// /api/pricing-config and /api/business-hub; nothing here is shipped as static code.
// The legacy walkthrough services (pressure wash, deep clean, shelving, totes, pest
// waste, mouse trapping) are the garage catalog's legacy service items, never duplicated
// here: scripts/generate-walkthrough-services.mjs copies just those items from
// functions/_data/garage-catalog.json into a plain module, which every Pages bundler
// includes (a JSON import needs import attributes Wrangler 3 cannot bundle) and which
// keeps the full catalog out of the Worker. Amounts are dollars, as the walkthrough has
// always used.

// Bump whenever any walkthrough price or minute changes: unsigned automatic totals
// saved under another version are recalculated, and the handoff records it as the
// quote's catalog_version. tests/pricing-config.test.mjs pins the tables to this label.
export const WALKTHROUGH_PRICING_VERSION = '2026-09-pest200-traps250';

const WALKTHROUGH_TABLES = {
  sizeBase: { 1: 450, 2: 650, 3: 850, other: 1100 }, defaultSize: '2',
  fill: { light: 0.75, medium: 1, full: 1.35, packed: 1.7 },
  perLoad: 1000,
  special: { Mattress: 45, 'Refrigerator / freezer': 60, Tires: 50, 'Paint / chemicals': 45, Electronics: 25, Appliances: 40, 'Piano / safe': 150, 'Very heavy items': 100 },
  access: { 'Long carry': 75, Stairs: 125 },
  minimum: 450, roundTo: 25,
};
// Elapsed job minutes, calibrated to a 2-person crew (the catalog's service crewSize).
const WALKTHROUGH_MINUTES = {
  base: 60, perLoad: 90, minLoads: 0.5, defaultLoads: 1,
  fill: { light: 0, medium: 30, full: 60, packed: 120 }, defaultFill: 30,
  perSpecial: 15, access: { 'Long carry': 30, Stairs: 30 },
  calibratedCrew: 2, min: 120, max: 540, roundTo: 30,
};

// The retired phone estimate range in the Hub's on-call flow.
const PHONE_QUOTE = {
  baseFee: 150, perCubicYard: 35, perFloor: 20, freeMiles: 25, perMile: 1, highSpread: 1.18, roundTo: 5,
  specials: [
    { id: 'fridge', name: 'Refrigerator', price: 60 },
    { id: 'washer', name: 'Washer / Dryer', price: 50 },
    { id: 'appliance', name: 'Other Appliance', price: 40 },
    { id: 'mattress', name: 'Mattress', price: 45 },
    { id: 'tire', name: 'Tire', price: 50 },
    { id: 'electronics', name: 'Electronics', price: 25 },
    { id: 'paint', name: 'Paint / Hazmat', price: 45 },
  ],
};

// Owner-only: the job-costing labor baseline, crew wages, truck economics and targets.
const OWNER_ECONOMICS = {
  laborCostPerCrewHour: 20,
  wages: { crew: 20, lead: 23 },
  truckRentalPerJob: { low: 150, high: 200 },
  targets: { averageTicket: 2250, walkthroughSetRatePct: 50, qualifiedCloseRatePct: 70 },
};

// The standard B2B partner rate card shown to a signed-in business account.
const B2B_RATE_CARD = {
  cards: [
    { value: '10%', title: 'Partner service savings', detail: 'Eligible cleanout, removal, cleaning and organization services.' },
    { value: '15%', title: 'Coordinated properties', detail: 'Three or more properties approved together and serviced within 30 days.' },
  ],
  terms: [
    'Discounts do not stack. The full-service reset base has a $450 minimum after discounts; standalone services have a $99 minimum. Products, specialty handling, access charges and the fixed $139 curbside offer are excluded. Your accepted quote controls.',
    'Full-service projects: 50% upfront and 50% on completion. Credit terms require a written agreement.',
  ],
};

export const PRICING_PARTS = Object.freeze(['walkthrough', 'phone', 'owner']);

const fail = (code, message, status = 503, details) => Object.assign(new Error(message), { code: `pricing_config_${code}`, status, ...(details ? { details } : {}) });
const catalogMismatch = reason => fail('catalog_mismatch', `The garage catalog's legacy walkthrough services no longer match the walkthrough price model: ${reason}.`, 503, { reason });
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const pricingFingerprint = value => [...sha256(new TextEncoder().encode(canonical(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// The shipped legacy service items, as the catalog (or a catalog-shaped test fixture) lists them.
const SERVICE_ITEMS = freeze(WALKTHROUGH_SERVICE_ITEMS);
export const walkthroughServiceItems = () => ({ items: SERVICE_ITEMS });

// The catalog validator's rules for the legacy fields priced from, checked on every
// request because only these items (not the validated catalog) reach the Worker.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const termText = value => value === undefined || typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 60;
function checkLegacyService(item) {
  const id = typeof item.id === 'string' && /^[a-z0-9][a-z0-9-]{1,79}$/.test(item.id) ? item.id : null, legacy = item.legacy;
  if (!id) throw catalogMismatch('a legacy service has no valid id');
  if (!AVAILABILITY.includes(item.availability)) throw catalogMismatch(`${id} has an unknown availability`);
  if (!Number.isSafeInteger(item.fixedPriceCents) || item.fixedPriceCents < 1 || item.fixedPriceCents > 10000000 || !plain(legacy) || !Number.isSafeInteger(legacy.jobMinutes) || legacy.jobMinutes < 0 || legacy.jobMinutes > 600) throw catalogMismatch(`${id} has no fixed price and job minutes`);
  if (typeof legacy.amountDollars !== 'number' || Math.round(legacy.amountDollars * 100) !== item.fixedPriceCents) throw catalogMismatch(`${id} legacy dollars must equal its fixed price`);
  if (typeof legacy.appliedBeforeRounding !== 'boolean' || !['finishId', 'hazard', 'shelfType'].every(key => termText(legacy[key]))) throw catalogMismatch(`${id} has malformed legacy terms`);
  if (legacy.garageSizes !== undefined && (!Array.isArray(legacy.garageSizes) || !legacy.garageSizes.length || legacy.garageSizes.some(size => !GARAGE_SIZES.includes(size)) || new Set(legacy.garageSizes).size !== legacy.garageSizes.length)) throw catalogMismatch(`${id} has malformed garage sizes`);
  return item;
}

// One legacy walkthrough service from the catalog: dollars and elapsed 2-person minutes.
function legacyServices(catalog) {
  const listed = (Array.isArray(catalog?.items) ? catalog.items : []).filter(item => item?.kind === 'service' && item.legacy);
  const ids = listed.map(checkLegacyService).map(item => item.id);
  if (new Set(ids).size !== ids.length) throw catalogMismatch('a legacy service id is repeated');
  const services = listed.filter(item => item.availability === 'active');
  const pick = (label, predicate, beforeRounding) => {
    const found = services.filter(predicate);
    if (!found.length) throw catalogMismatch(`no active ${label} service`);
    for (const item of found) if (item.legacy.appliedBeforeRounding !== beforeRounding) throw catalogMismatch(`${item.id} must be applied ${beforeRounding ? 'before' : 'after'} rounding`);
    return found;
  };
  const entry = item => ({ amount: item.fixedPriceCents / 100, minutes: item.legacy.jobMinutes, itemId: item.id });
  const single = (label, predicate, beforeRounding) => { const found = pick(label, predicate, beforeRounding); if (found.length !== 1) throw catalogMismatch(`more than one ${label} service`); return found[0]; };
  const keyed = (label, found, keyOf, keys) => {
    const out = {};
    for (const item of found) { const key = keyOf(item); if (!keys.includes(key) || out[key]) throw catalogMismatch(`${label} service ${item.id} has an unexpected or repeated ${key}`); out[key] = entry(item); }
    for (const key of keys) if (!out[key]) throw catalogMismatch(`no ${label} service for ${key}`);
    return out;
  };
  const wash = single('pressure wash', item => item.legacy.finishId === 'pressure_wash', true);
  if (JSON.stringify(wash.legacy.garageSizes) !== JSON.stringify(['1'])) throw catalogMismatch('the walkthrough offers the pressure wash for one-car garages only');
  const deep = pick('deep clean', item => item.legacy.finishId === 'deep_clean', true);
  const shelving = pick('shelving', item => item.legacy.finishId === 'shelving', true);
  return {
    pressure_wash: entry(wash),
    deep_clean: { bySize: keyed('deep clean', deep, item => item.legacy.garageSizes?.length === 1 ? item.legacy.garageSizes[0] : '', GARAGE_SIZES) },
    shelving: { byType: keyed('shelving', shelving, item => item.legacy.shelfType || '', ['metal', 'wood', 'plastic']), defaultType: 'metal' },
    totes: entry(single('tote', item => item.legacy.finishId === 'totes', true)),
    mouse_trapping: entry(single('mouse trapping', item => item.legacy.finishId === 'mouse_trapping', false)),
    pest_waste: entry(single('pest waste', item => item.legacy.hazard === 'Pest waste', false)),
  };
}

// The walkthrough tables the browser prices with (recommend() and estimatedJobMinutes()).
export function walkthroughPricing(catalog) {
  const { pest_waste: pestWaste, ...services } = legacyServices(catalog);
  return freeze({ version: WALKTHROUGH_PRICING_VERSION, ...clone(WALKTHROUGH_TABLES), services, hazards: { 'Pest waste': pestWaste }, minutes: clone(WALKTHROUGH_MINUTES) });
}
export const phoneQuotePricing = () => freeze(clone(PHONE_QUOTE));
export const ownerEconomics = () => freeze(clone(OWNER_ECONOMICS));
// Every business account sees the standard partner card today; the account is the hook for a negotiated one.
export const businessRateCard = account => account && typeof account === 'object' ? clone(B2B_RATE_CARD) : null;

// The served parts and a content version: the same tables always give the same version.
export async function pricingConfig(parts, { catalog = walkthroughServiceItems } = {}) {
  const wanted = [...new Set(parts)];
  if (!wanted.length || wanted.some(part => !PRICING_PARTS.includes(part))) throw fail('invalid_parts', 'Choose walkthrough, phone or owner pricing.', 400);
  const out = {};
  if (wanted.includes('walkthrough')) out.walkthrough = walkthroughPricing(await catalog());
  if (wanted.includes('phone')) out.phone = phoneQuotePricing();
  if (wanted.includes('owner')) out.owner = ownerEconomics();
  return { version: `pc_${pricingFingerprint(out).slice(0, 16)}`, parts: out };
}
