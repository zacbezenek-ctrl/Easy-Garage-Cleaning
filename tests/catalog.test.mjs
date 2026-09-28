import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { AUDIT_STATUS, GARAGE_SIZES, PRODUCT_CATEGORIES, optionsForNeed, settingsReadyForCustomers, staleItems, validateCatalog, validatePricingSettings } from '../functions/_lib/catalog.js';

const readJson = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const shipped = readJson('../functions/_data/garage-catalog.json');
const defaults = readJson('../functions/_data/pricing-settings.defaults.json');
const fresh = () => structuredClone(shipped);
const byId = id => shipped.items.find(item => item.id === id);
const TIER_RANK = { good: 0, better: 1, best: 2 };
const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => { out.push(key); strings(entry, out); });
  return out;
};
function rejects(mutate, path, reason) {
  const catalog = fresh();
  mutate(catalog);
  assert.throws(() => validateCatalog(catalog), error => {
    assert.equal(error.code, 'catalog_invalid');
    assert.equal(error.status, 400);
    assert.equal(error.details.path, path);
    if (reason) assert.match(error.details.reason, reason);
    assert.ok(error.message.includes(path), 'the message names the failing path');
    return true;
  });
}

test('the shipped catalog validates and carries its version metadata', () => {
  assert.equal(validateCatalog(shipped), shipped);
  assert.equal(shipped.schemaVersion, 1);
  assert.equal(shipped.catalogVersion, '2026-09-27.1');
  assert.equal(shipped.staleAfterDays, 90);
  assert.deepEqual(shipped.categories.map(category => category.id).filter(id => id !== 'services').sort(), [...PRODUCT_CATEGORIES].sort());
  assert.ok(shipped.items.filter(item => item.kind === 'product').length >= 230, 'the research items are all published');
  assert.equal(new Set(shipped.items.map(item => item.id)).size, shipped.items.length);
});

test('every need claimed as full has at least 3 active options across tiers, and thinner needs say why', () => {
  const full = shipped.needs.filter(need => need.coverage === 'full');
  assert.ok(full.length >= 50, 'most needs are fully covered');
  for (const need of shipped.needs) {
    const members = shipped.items.filter(item => item.needs.includes(need.id));
    const active = members.filter(item => item.availability === 'active');
    assert.ok(members.length, `${need.id} has items`);
    if (need.coverage === 'full') {
      assert.ok(active.length >= 3, `${need.id} has ${active.length} active options`);
      assert.ok(new Set(active.map(item => item.tier)).size >= 2, `${need.id} spans tiers`);
      assert.deepEqual(optionsForNeed(shipped, need.id).map(item => item.id).sort(), active.map(item => item.id).sort());
    } else if (need.coverage === 'limited' || need.coverage === 'referral_only') assert.ok(need.coverageNote?.length > 20, `${need.id} explains its coverage`);
    else assert.ok(members.every(item => item.kind === 'service'), `${need.id} is a service need`);
  }
  assert.equal(shipped.needs.find(need => need.id === 'floor-coating').coverage, 'referral_only');
});

test('no image URLs or image fields anywhere in the catalog, and the validator rejects them', () => {
  for (const value of strings(shipped)) {
    assert.doesNotMatch(value, /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?$/i, value);
    assert.doesNotMatch(value, /media-amazon\.com|walmartimages\.com|thdstatic\.com|mobileimages\.lowes\.com/i, value);
  }
  rejects(catalog => { catalog.items[4].safetyNotes += ' See https://m.media-amazon.com/images/I/81abc.jpg for the bracket.'; }, 'catalog.items[4].safetyNotes', /image URL/);
  rejects(catalog => { catalog.items[0].sources[0].url = 'https://www.example.com/rack.webp?w=600'; }, 'catalog.items[0].sources[0].url', /image URL/);
  rejects(catalog => { catalog.items[2].imageUrl = 'https://www.example.com/x'; }, 'catalog.items[2].imageUrl', /image fields/);
});

test('every item has a source or is marked unverified, with a traceable verification date', () => {
  for (const item of shipped.items) {
    assert.ok(item.sources.length >= 1 || item.priceVerified === false, item.id);
    if (item.priceVerified) {
      assert.match(item.priceVerifiedAt, /^\d{4}-\d{2}-\d{2}$/, item.id);
      assert.ok(item.sources.some(source => source.checkedOn === item.priceVerifiedAt), item.id);
    } else {
      assert.equal(item.priceVerifiedAt, null, item.id);
      assert.ok(item.verificationNote.length > 20, `${item.id} explains why the price is unverified`);
    }
    for (const source of item.sources) if (source.url) assert.match(source.url, /^https:\/\//, item.id);
    if (item.kind === 'product') {
      assert.ok(Number.isSafeInteger(item.retailPriceLowCents) && item.retailPriceLowCents <= item.retailPriceHighCents, item.id);
      assert.ok(Number.isInteger(item.installMinutes), item.id);
    }
  }
  assert.ok(shipped.items.filter(item => item.priceVerified).length > 100, 'plenty of snippet-observed prices remain');
});

test('audit findings are applied: bad URLs removed, suspect prices unverified, unsafe items hidden', () => {
  const urls = shipped.items.flatMap(item => item.sources.map(source => source.url || ''));
  for (const removed of ['us.amazon.com', 'wruvsa.com', 'video.costco.com', 'walmart.com/c/kp/golf-caddy', '/4000400040', '/4000400400', 'walmart.com/ip/seort/', 'brands-smith.com', 'greenhousemegastore.com', 'etrailer.com/Bike-Storage/Feedback-Sports/FS98VR', 'amazon.com/clp/', 'Rapid-Reel']) {
    assert.ok(!urls.some(url => url.includes(removed)), `${removed} is gone`);
  }
  for (const suspect of ['cargo-lift-thule-multilift-572', 'lawn-hose-flexzilla-pro-retractable-half-70', 'lawn-hose-giraffe-retractable-half-100', 'small-items-akro-mils-louvered-panel-16-bin-set', 'overhead-hoist-garage-gator-ggr220', 'golf-caddy-gladiator-gawuxxgftg']) {
    assert.equal(byId(suspect).priceVerified, false, suspect);
    assert.equal(byId(suspect).auditStatus, 'fixed_per_audit', suspect);
  }
  for (const hidden of ['overhead-lift-onrax-motorized', 'lawn-mower-hanger-generic-walmart', 'lawn-mower-hanger-ebay-heavy-duty', 'cargo-lift-thule-multilift-572']) assert.equal(byId(hidden).availability, 'hidden', hidden);
  assert.equal(byId('bike-pivot-steadyrack-proflex-narrow').tier, byId('bike-ebike-steadyrack-proflex-wide-fat').tier, 'same product line, same price, same tier');
  assert.equal(byId('small-items-akro-mils-louvered-panel-16-bin-set').retailPriceHighCents, 14999, 'the $399.99 compare-at price is excluded');
  for (const coating of ['coating-rust-oleum-epoxyshield-diy-kit', 'coating-rust-oleum-rocksolid-polycuramine-2-5car']) {
    assert.deepEqual([byId(coating).availability, byId(coating).installMinutes, byId(coating).haulAwayApplicable], ['referral_only', 0, false], 'no phantom coating labor');
  }
  for (const item of shipped.items) {
    if (item.installRequirements.includes('two-person-lift')) assert.ok(item.crewSize >= 2, item.id);
    assert.ok(AUDIT_STATUS.includes(item.auditStatus), item.id);
  }
});

test('duplicates are merged and the audit log adds up', () => {
  const log = shipped.auditLog;
  assert.deepEqual(log.removedItems.map(entry => entry.id).sort(), ['bike-hook-rubbermaid-fasttrack-vertical', 'camping-bins-generic-27gal-totes', 'camping-shelving-bay-generic', 'overhead-rack-saferacks-super-duty-4x8-2pack-costco']);
  const hook = byId('rail-hook-rubbermaid-fasttrack-vertical-bike');
  assert.deepEqual(hook.needs.sort(), ['bike-vertical-hook', 'rail-accessories']);
  assert.equal(shipped.items.filter(item => item.model === '1784463').length, 1);
  for (const [type, ids] of Object.entries(log.itemsByFix)) assert.equal(log.counts[type], ids.length, type);
  for (const type of ['tier_corrected', 'price_marked_unverified', 'price_range_corrected', 'safety_notes_written', 'two_person_crew_added', 'duplicate_removed', 'availability_changed', 'source_removed_url_wrong']) assert.ok(log.counts[type] > 0, type);
  assert.equal(log.publishedItems, shipped.items.length);
  assert.deepEqual(log.selfReviewedCategories, ['shelving', 'wall-systems']);
  assert.ok(shipped.items.filter(item => item.category === 'shelving' || item.category === 'wall-systems').every(item => /self|fixed_per_audit/.test(item.auditStatus)), 'unaudited categories were self-reviewed');
});

test('validateCatalog is strict and reports the exact failing path', () => {
  rejects(catalog => { catalog.items[3].color = 'red'; }, 'catalog.items[3].color', /not an allowed field/);
  rejects(catalog => { catalog.items[0].retailPriceLowCents = catalog.items[0].retailPriceHighCents + 1; }, 'catalog.items[0].retailPriceHighCents');
  rejects(catalog => { const item = catalog.items.find(entry => entry.priceVerified && entry.kind === 'product'); item.sources = []; }, `catalog.items[${shipped.items.findIndex(entry => entry.priceVerified && entry.kind === 'product')}].sources`, /verified price/);
  rejects(catalog => { catalog.items[5].sources[0].url = 'http://www.homedepot.com/p/x/1'; }, 'catalog.items[5].sources[0].url', /https/);
  rejects(catalog => { catalog.items[1].needs = ['not-a-need']; }, 'catalog.items[1].needs[0]');
  rejects(catalog => { catalog.items[7].id = catalog.items[6].id; }, 'catalog.items', /repeat/);
  const referral = shipped.items.findIndex(item => item.availability === 'referral_only');
  rejects(catalog => { catalog.items[referral].installMinutes = 60; }, `catalog.items[${referral}].availability`, /referral/);
  const lift = shipped.items.findIndex(item => item.installRequirements.includes('two-person-lift'));
  rejects(catalog => { catalog.items[lift].crewSize = 1; }, `catalog.items[${lift}].crewSize`);
  const unverified = shipped.items.findIndex(item => !item.priceVerified);
  rejects(catalog => { catalog.items[unverified].verificationNote = null; }, `catalog.items[${unverified}].verificationNote`);
  rejects(catalog => { catalog.items[unverified].priceVerifiedAt = '2026-09-27'; }, `catalog.items[${unverified}].priceVerifiedAt`);
  const limited = shipped.needs.findIndex(need => need.coverage === 'limited');
  rejects(catalog => { catalog.needs[limited].coverage = 'full'; }, `catalog.needs[${limited}].coverage`, /claims full/);
  rejects(catalog => { catalog.catalogVersion = 'latest'; }, 'catalog.catalogVersion');
  rejects(catalog => { catalog.catalogVersion = '2026-09-28.1'; }, 'catalog.generatedOn', /date in catalogVersion/);
  rejects(catalog => { catalog.items[0].sources[0].checkedOn = '2026-09-31'; }, 'catalog.items[0].sources[0].checkedOn');
  rejects(catalog => { catalog.auditLog.counts.tier_corrected += 1; }, 'catalog.auditLog.counts.tier_corrected');
  const service = shipped.items.findIndex(item => item.kind === 'service');
  rejects(catalog => { catalog.items[service].fixedPriceCents += 1; }, `catalog.items[${service}].legacy.amountDollars`);
  rejects(catalog => { catalog.items[service].crewSize = 1; }, `catalog.items[${service}].crewSize`, /2-person crew/);
  rejects(catalog => { catalog.items[service].legacy.garageSizes = ['4']; }, `catalog.items[${service}].legacy.garageSizes[0]`);
  // LI-CORE line limits: per-unit minutes up to 1440, names up to 160 characters, item ids up to 80.
  rejects(catalog => { catalog.items[0].installBatchSize = 10; }, 'catalog.items[0].installBatchSize', /not an allowed field/);
  rejects(catalog => { catalog.items[0].installMinutes = 1441; }, 'catalog.items[0].installMinutes');
  rejects(catalog => { catalog.items[0].name = 'N'.repeat(161); }, 'catalog.items[0].name');
  rejects(catalog => { catalog.items[0].id = 'a'.repeat(81); }, 'catalog.items[0].id');
  rejects(catalog => { catalog.auditLog.normalizationItems.haulaway_defaulted_on.pop(); }, 'catalog.auditLog.normalizationItems.haulaway_defaulted_on', /normalization count/);
  rejects(catalog => { catalog.auditLog.normalizationItems.guessed = []; }, 'catalog.auditLog.normalizationItems.guessed', /not a normalization type/);
  assert.throws(() => validateCatalog(null), { code: 'catalog_invalid' });
});

test('review fixes: whole-minute price units, itemized haul-away defaults and recorded tier rationale', () => {
  const log = shipped.auditLog;
  assert.deepEqual(log.normalizationItems.priced_per_install_batch, ['floor-tile-racedeck-diamond-12x12', 'floor-tile-racedeck-free-flow-drain', 'floor-tile-swisstrax-ribtrax-pro', 'shelving-everbilt-14337-bracket-diy-wall-shelf']);
  for (const id of log.normalizationItems.priced_per_install_batch) {
    assert.ok(!('installBatchSize' in byId(id)), id);
    assert.match(byId(id).priceUnit, /^per (?:10|set of 3) /, id);
    assert.equal(byId(id).haulAwayApplicable, false, `${id} carries no per-unit packaging charge`);
  }
  assert.equal(log.normalizationItems.haulaway_defaulted_on.length + log.normalizationItems.haulaway_defaulted_off.length, 50);
  for (const [type, ids] of Object.entries(log.normalizationItems)) for (const id of ids) assert.ok(byId(id), `${type} ${id}`);
  for (const id of log.normalizationItems.haulaway_defaulted_on) assert.ok(byId(id).auditActions.includes('normalized: haulAwayApplicable defaulted to true (missing in research)'), id);
  for (const id of ['lawn-power-tool-hanger-4pk-yx912', 'lawn-rack-storeyourboard-omni-tool', 'overhead-platform-kobalt-54014-48x48', 'overhead-lift-racor-phl-1r-4x4']) {
    assert.match(byId(id).verificationNote, /Tier rationale: /, id);
    assert.ok(log.itemsByFix.caveat_recorded.includes(id), id);
  }
});

test('legacy services assume a 2-person crew and carry machine-readable garage sizes', () => {
  const services = shipped.items.filter(item => item.kind === 'service');
  assert.ok(services.every(item => item.crewSize === 2));
  assert.deepEqual(Object.fromEntries(services.filter(item => item.legacy.garageSizes).map(item => [item.id, item.legacy.garageSizes])), { 'svc-pressure-wash-1car': ['1'], 'svc-deep-clean-1car': ['1'], 'svc-deep-clean-2car': ['2'], 'svc-deep-clean-3car': ['3'], 'svc-deep-clean-large': ['other'] });
  assert.deepEqual(GARAGE_SIZES, ['1', '2', '3', 'other'], 'the walkthrough S.garageSize values');
  assert.deepEqual(optionsForNeed(shipped, 'egc-pressure-wash', { garageSize: '1' }).map(item => item.id), ['svc-pressure-wash-1car']);
  assert.deepEqual(optionsForNeed(shipped, 'egc-pressure-wash', { garageSize: '2' }), [], 'recommend() never offers the wash for a 2-car garage');
  for (const size of GARAGE_SIZES) assert.deepEqual(optionsForNeed(shipped, 'egc-deep-clean', { garageSize: size }).map(item => item.legacy.garageSizes), [[size]], size);
  assert.equal(optionsForNeed(shipped, 'egc-deep-clean').length, 4, 'without a size every deep-clean price is listed');
  assert.deepEqual(optionsForNeed(shipped, 'egc-shelving-unit', { garageSize: '3' }).length, 3, 'unsized services are unaffected');
  assert.deepEqual(optionsForNeed(shipped, 'overhead-rack-4x8', { garageSize: 'other' }), optionsForNeed(shipped, 'overhead-rack-4x8'), 'products are unaffected');
  const floor = optionsForNeed(shipped, 'floor', { garageSize: '3' }).filter(item => item.kind === 'service').map(item => item.id);
  assert.ok(floor.includes('svc-deep-clean-3car') && !floor.includes('svc-deep-clean-1car') && !floor.includes('svc-pressure-wash-1car'), 'zone lookups filter sized services too');
  assert.throws(() => optionsForNeed(shipped, 'egc-deep-clean', { garageSize: 2 }), error => error.code === 'catalog_invalid_garage_size' && error.status === 400);
});

test('staleItems uses the injected clock, Denver calendar days and the 90-day window', () => {
  const unverified = shipped.items.filter(item => !item.priceVerifiedAt).map(item => item.id).sort();
  const soon = staleItems(shipped, new Date('2026-10-01T18:00:00.000Z'));
  assert.deepEqual(soon.map(entry => entry.id).sort(), unverified, 'right after research only never-verified prices are stale');
  assert.ok(soon.every(entry => entry.reason === 'never_verified' && entry.ageDays === null && entry.priceVerifiedAt === null));
  // 2026-12-26 in Denver is exactly 90 days after 2026-09-27: not yet older than 90 days.
  assert.equal(staleItems(shipped, '2026-12-27T05:00:00.000Z').length, unverified.length, 'still Dec 26 in Denver (UTC-7)');
  const late = staleItems(shipped, '2026-12-27T07:30:00.000Z');
  const verified = shipped.items.filter(item => item.priceVerifiedAt);
  assert.equal(late.length, shipped.items.length, 'Dec 27 in Denver: every verified price is now 91 days old');
  const aged = late.find(entry => entry.id === verified[0].id);
  assert.deepEqual([aged.reason, aged.ageDays, aged.priceVerifiedAt], ['older_than_window', 91, '2026-09-27']);
  assert.equal(late[0].priceVerifiedAt, null, 'never-verified prices sort first');
  assert.equal(staleItems(shipped, '2026-10-08T18:00:00Z', 7).length, shipped.items.length, 'a custom window');
  assert.equal(staleItems(shipped, '2026-10-04T18:00:00Z', 7).length, unverified.length);
  assert.throws(() => staleItems(shipped, 'yesterday'), { code: 'catalog_invalid_clock' });
  assert.throws(() => staleItems(shipped, new Date('nope')), { code: 'catalog_invalid_clock' });
  assert.throws(() => staleItems(shipped, '2026-10-01T18:00:00Z', 0), { code: 'catalog_invalid_window' });
});

test('staleItems defaults to the catalog\'s own staleAfterDays', () => {
  const catalog = fresh(), unverified = shipped.items.filter(item => !item.priceVerifiedAt).length;
  catalog.staleAfterDays = 30;
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(staleItems(catalog, '2026-10-27T18:00:00Z').length, unverified, 'Oct 27 in Denver: verified prices are exactly 30 days old');
  assert.equal(staleItems(catalog, '2026-10-28T18:00:00Z').length, catalog.items.length, 'Oct 28: 31 days old, stale under a 30-day window');
  assert.equal(staleItems(shipped, '2026-10-28T18:00:00Z').length, unverified, 'the shipped 90-day window');
  assert.equal(staleItems(catalog, '2026-10-28T18:00:00Z', 90).length, unverified, 'an explicit window still wins');
});

test('the documented re-verification flow publishes a fresh price that is no longer stale', () => {
  const catalog = fresh(), index = catalog.items.findIndex(item => item.id === 'wall-cabinet-husky-rta-28'), cabinet = catalog.items[index];
  assert.equal(cabinet.priceVerified, false);
  Object.assign(cabinet, { retailPriceLowCents: 12900, retailPriceHighCents: 13900, priceVerified: true, priceVerifiedAt: '2026-10-15', priceEvidence: 'product_page', verificationNote: null });
  cabinet.sources.push({ url: 'https://www.homedepot.com/p/synthetic-recheck/000000001', retailer: 'The Home Depot', observedPrice: '$129.00 (product page, synthetic re-check)', checkedOn: '2026-10-15' });
  assert.throws(() => validateCatalog(catalog), error => error.details.path === `catalog.items[${index}].sources[${cabinet.sources.length - 1}].checkedOn`, 'a check dated after generatedOn is rejected');
  Object.assign(catalog, { catalogVersion: '2026-10-15.1', generatedOn: '2026-10-15' });
  assert.equal(validateCatalog(catalog), catalog);
  const stale = staleItems(catalog, '2026-10-16T18:00:00Z').map(entry => entry.id);
  assert.ok(!stale.includes('wall-cabinet-husky-rta-28'));
  assert.ok(staleItems(catalog, '2027-01-14T18:00:00Z').some(entry => entry.id === 'wall-cabinet-husky-rta-28' && entry.ageDays === 91));
  cabinet.priceVerified = false; cabinet.priceVerifiedAt = null; cabinet.verificationNote = 'Synthetic: price withdrawn pending a new check.';
  assert.throws(() => validateCatalog(catalog), error => error.details.path === `catalog.items[${index}].priceEvidence`, 'product-page evidence cannot back an unverified price');
});

test('optionsForNeed returns active options by need or zone, sorted good to best', () => {
  const racks = optionsForNeed(shipped, 'overhead-rack-4x8');
  assert.ok(racks.length >= 3);
  assert.ok(racks.every(item => item.needs.includes('overhead-rack-4x8') && item.availability === 'active'));
  for (let i = 1; i < racks.length; i++) {
    const [a, b] = [racks[i - 1], racks[i]];
    assert.ok(TIER_RANK[a.tier] < TIER_RANK[b.tier] || TIER_RANK[a.tier] === TIER_RANK[b.tier] && a.retailPriceHighCents <= b.retailPriceHighCents, `${a.id} before ${b.id}`);
  }
  assert.ok(!optionsForNeed(shipped, 'overhead-lift').some(item => item.id === 'overhead-lift-onrax-motorized'), 'hidden items never appear');
  assert.deepEqual(optionsForNeed(shipped, 'floor-coating'), [], 'referral-only items are excluded by default');
  assert.equal(optionsForNeed(shipped, 'floor-coating', { includeReferral: true }).length, 4);
  const ceiling = optionsForNeed(shipped, 'ceiling');
  assert.ok(ceiling.length > 20 && ceiling.every(item => item.zones.includes('ceiling')));
  assert.deepEqual(optionsForNeed(shipped, 'egc-shelving-unit').map(item => item.fixedPriceCents), [34900, 44900, 49900]);
  assert.throws(() => optionsForNeed(shipped, 'teleporter'), error => error.code === 'catalog_unknown_need' && error.status === 404);
  const power = optionsForNeed(shipped, 'power-equipment-wall'), verified = optionsForNeed(shipped, 'power-equipment-wall', { verifiedOnly: true });
  assert.ok(power.some(item => item.priceEvidence === 'estimate'));
  assert.deepEqual(verified.map(item => item.id), power.filter(item => item.priceVerified).map(item => item.id), 'verifiedOnly drops estimate and unconfirmed prices');
  assert.ok(verified.length >= 1 && verified.every(item => item.priceVerified === true));
});

test('default pricing settings are complete placeholders that block customer use', () => {
  assert.equal(validatePricingSettings(defaults), defaults);
  assert.equal(defaults.mustSetBeforeCustomerUse, true);
  assert.equal(settingsReadyForCustomers(defaults), false);
  assert.equal(settingsReadyForCustomers({ ...defaults, mustSetBeforeCustomerUse: false }), true);
  for (const key of Object.keys(defaults).filter(key => key !== 'comments')) assert.ok(defaults.comments[key]?.length > 20, `${key} has a comment`);
  for (const key of ['laborRateCents', 'markupPct', 'minimumJobCents', 'disposalCentsPerItem', 'includeDisposal']) assert.match(defaults.comments[key], /PLACEHOLDER/, key);
  assert.ok(defaults.laborRateCents >= 5000 && defaults.laborRateCents <= 9000, 'inside the observed Fort Collins handyman range of $50-$90/hr');
  assert.deepEqual(Object.keys(defaults.markupPct.byCategory).sort(), [...PRODUCT_CATEGORIES].sort());
});

test('deposit and minimum placeholders match the current walkthrough pricing in crew/gameplan.html', () => {
  const html = fs.readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  const line = prefix => html.split(/\r?\n/).find(row => row.startsWith(prefix));
  const context = vm.createContext({});
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { garageSize: '1', fill: 'light', loads: '' });
  for (const prefix of ['function recommend(', 'function walkthroughDeposit(']) vm.runInContext(line(prefix), context);
  assert.equal(context.recommend() * 100, defaults.minimumJobCents, 'the lightest one-car job lands on the $450 floor');
  assert.equal(Math.round(context.walkthroughDeposit(1000.01).amount * 100), Math.round(100001 * defaults.depositPct / 100));
});

test('validatePricingSettings rejects malformed settings with the exact path', () => {
  const bad = (mutate, path) => {
    const settings = structuredClone(defaults);
    mutate(settings);
    assert.throws(() => validatePricingSettings(settings), error => error.code === 'catalog_settings_invalid' && error.details.path === path);
  };
  bad(settings => { settings.laborRate = 5000; }, 'settings.laborRate');
  bad(settings => { settings.laborRateCents = -1; }, 'settings.laborRateCents');
  bad(settings => { settings.laborRateCents = 75.5; }, 'settings.laborRateCents');
  bad(settings => { settings.markupPct.default = 20.125; }, 'settings.markupPct.default');
  bad(settings => { settings.markupPct.byCategory.hottubs = 10; }, 'settings.markupPct.byCategory.hottubs');
  bad(settings => { settings.roundingRule = 'banker'; }, 'settings.roundingRule');
  bad(settings => { settings.mustSetBeforeCustomerUse = 'no'; }, 'settings.mustSetBeforeCustomerUse');
  bad(settings => { delete settings.minimumJobCents; }, 'settings.minimumJobCents');
  bad(settings => { settings.comments.surprise = 'x'; }, 'settings.comments.surprise');
  bad(settings => { settings.depositPct = 101; }, 'settings.depositPct');
  const { comments, ...bare } = structuredClone(defaults);
  assert.ok(comments);
  assert.equal(validatePricingSettings(bare), bare, 'comments are optional for stored owner settings');
});
