# Garage product catalog

The garage product catalog contains storage products and EGC services. **Hub → System → Catalog & pricing** lets the owner inspect products, review pricing settings, publish catalog versions and build product installation quotes. The catalog and settings APIs store immutable versions and save receipts in Firestore. Existing walkthrough service prices use their separate price table.

**Customer release gate:** catalog quotes require `CATALOG_QUOTES_ENABLED=true`, owner-approved pricing settings, and current verified product prices. The shipped installation settings remain placeholders. Do not treat this implementation or a green test as approval of those rates or proof that the live flag is enabled.

| File | What it is |
|---|---|
| `functions/_data/garage-catalog.json` | The catalog: `catalogVersion` `2026-09-27.1`, `schemaVersion` 1, 250 items, 62 customer needs and the audit log. |
| `functions/_data/pricing-settings.defaults.json` | **Placeholder** owner pricing settings. `mustSetBeforeCustomerUse` is `true`. |
| `functions/_lib/catalog.js` | `validateCatalog`, `validatePricingSettings`, `optionsForNeed`, `staleItems`, `computeSellPriceCents`, `catalogLine`, `applyMinimum`, `settingsReadyForCustomers`. Pure functions, integer cents, injected clock. |
| `employee-catalog.js`, `employee-catalog-quote.js` | Owner catalog administration and the phone-friendly product quote composer. |
| `functions/_lib/catalog-quote.js`, `functions/api/quote-draft.js` | Server price preview, verified save and the existing separately confirmed send flow. |
| `tests/catalog.test.mjs`, `tests/catalog-pricing.test.mjs` | The contract for the data and the pricing math. |

The catalog is a Pages Functions data file, not a website page. The `functions/` directory is compiled into the Worker and is not expected to be served as a static asset. The edge middleware's private-path list does not name `/functions`, so the owner checklist includes a one-time check that `/functions/_data/garage-catalog.json` returns 404 in production.

## Summary

The catalog has 239 products and 11 EGC service items. The research covered 243 products; 4 duplicates were removed (see [Audit outcome](#audit-outcome)).

| Category | Items | Good | Better | Best | Price verified | Hidden | Referral only |
|---|---:|---:|---:|---:|---:|---:|---:|
| Bikes (`bikes`) | 25 | 10 | 8 | 7 | 16 | 0 | 0 |
| Cabinets and workbenches (`cabinets-workbenches`) | 29 | 11 | 10 | 8 | 9 | 0 | 0 |
| Floors, lighting and extras (`floors-lighting-extras`) | 30 | 9 | 13 | 8 | 8 | 0 | 4 |
| Lawn and garden (`lawn-garden`) | 25 | 12 | 6 | 7 | 12 | 2 | 0 |
| Overhead storage (`overhead`) | 21 | 7 | 8 | 6 | 5 | 1 | 0 |
| Shelving (`shelving`) | 25 | 12 | 8 | 5 | 21 | 0 | 0 |
| Small items, totes and hooks (`small-items`) | 26 | 9 | 10 | 7 | 16 | 0 | 0 |
| Sports and outdoor (`sports-outdoor`) | 28 | 10 | 10 | 8 | 11 | 1 | 0 |
| Wall systems (`wall-systems`) | 30 | 9 | 13 | 8 | 28 | 0 | 0 |
| EGC services (`services`) | 11 | 1 | 1 | 1 | 11 | 0 | 0 |
| **Total** | **250** | **90** | **87** | **65** | **137** | **4** | **4** |

Eight service items have no tier because they are single fixed-price services. Only the three EGC shelving units are tiered.

### Customer needs

Each item belongs to one or more needs, and each need is tagged with its coverage. `validateCatalog` recomputes coverage from the items and rejects any mismatch:

- `full`: at least 3 active options across at least 2 tiers. 54 needs are full.
- `limited`: fewer options, with a note explaining why. Only `bike-horizontal-wall` is limited.
- `referral_only`: EGC does not install these; `floor-coating` is referral only.
- `service`: EGC's own fixed-price services (6 needs).

`optionsForNeed(catalog, needOrZone, options)` returns a need's active options sorted good, better, best, then by price. It also accepts a zone (`walls`, `ceiling`, `floor`, `corners`, `bikes`, `sports`, `tools`, `small-items`, `lawn-garden`). Hidden items are never returned. Options:

- `includeReferral: true` also returns referral-only items.
- `verifiedOnly: true` drops items whose price is an estimate or an unconfirmed snippet.
- `garageSize` (`'1'`, `'2'`, `'3'` or `'other'`, the walkthrough's `S.garageSize` values) drops EGC services priced for another garage size, such as the one-car pressure wash on a 2-car job. `recommend()` prices an unknown size as `'2'`, so pass `'2'` when the size is unknown.

| Need (`id`) | Coverage | Active options | Tiers | Verified prices |
|---|---|---:|---|---:|
| Hang one bike vertically by the wheel (`bike-vertical-hook`) | full | 5 | good, better, best | 4 |
| Store or display one bike horizontally on a wall (`bike-horizontal-wall`) | limited | 2 | good, better | 1 |
| Pivoting vertical bike rack that folds flat to save width (`bike-pivot-rack`) | full | 5 | good, better, best | 2 |
| Lift one bike to the ceiling with a hoist (`bike-ceiling-hoist`) | full | 3 | good, better | 3 |
| No-drill floor stand for 1-2 bikes (`bike-floor-stand`) | full | 4 | good, better, best | 2 |
| Store 4-6+ bikes on one wall or ceiling system (`bike-multi-rack`) | full | 4 | good, better, best | 4 |
| Store heavy e-bikes (50-80 lb) safely (`ebike-storage`) | full | 3 | good, best | 1 |
| Full-wall matching metal cabinet system (`cabinet-system`) | full | 7 | good, better, best | 5 |
| Single tall locking steel cabinet (`tall-cabinet`) | full | 7 | good, better, best | 4 |
| Wall-mounted cabinet above a bench or vehicle hood (`wall-cabinet`) | full | 4 | good, better, best | 0 |
| Rolling tool chest for hand tools (`rolling-tool-chest`) | full | 4 | good, better, best | 0 |
| Fixed-height workbench (`workbench-fixed`) | full | 3 | good, better, best | 0 |
| Adjustable-height workbench (`workbench-adjustable`) | full | 4 | good, better, best | 0 |
| Interlocking floor tiles (full floor or zone) (`floor-tiles`) | full | 5 | good, better, best | 2 |
| Parking-bay mat for snowmelt and fluids (`parking-mat`) | full | 4 | good, better, best | 2 |
| Garage floor coating (epoxy or polyaspartic) (`floor-coating`) | referral_only | 0 | - | 0 |
| Brighter LED garage lighting (`led-lighting`) | full | 4 | good, better, best | 3 |
| Garage-ready refrigerator or freezer zone (`fridge-freezer-zone`) | full | 4 | good, better, best | 0 |
| Trash and recycling bin holder or corral (`trash-recycling`) | full | 3 | good, better, best | 0 |
| Kid gear: balls, scooters, helmets (`kid-gear`) | full | 3 | good, better, best | 0 |
| Pet gear station: leashes, food, toys (`pet-gear`) | full | 3 | good, better, best | 0 |
| Hang rakes, shovels and brooms on the wall (`long-tool-wall-rack`) | full | 4 | good, better, best | 4 |
| Freestanding or rolling long-handled tool tower (`long-tool-tower`) | full | 4 | good, better, best | 2 |
| Wall-mounted garden hose reel (`hose-wall-reel`) | full | 6 | good, better, best | 1 |
| Mobile or freestanding hose storage (`hose-cart`) | full | 3 | good, best | 2 |
| Hang a wheelbarrow on the wall (`wheelbarrow-hanger`) | full | 3 | good, better, best | 1 |
| Wall storage for mower, trimmer, blower and edger (`power-equipment-wall`) | full | 3 | good, better, best | 2 |
| Overhead bin storage: full 4 x 8 ceiling rack (`overhead-rack-4x8`) | full | 7 | good, better, best | 3 |
| Narrow overhead rack (3 x 8 or 2 x 8) (`overhead-rack-narrow`) | full | 3 | good, better, best | 0 |
| Small overhead platform (about 4 x 4) (`overhead-platform-small`) | full | 3 | good, better, best | 1 |
| Overhead lift that lowers storage to the floor (`overhead-lift`) | full | 4 | good, better | 1 |
| Motorized ceiling hoist for bikes, boats and cargo boxes (`ceiling-hoist-motorized`) | full | 3 | good, better, best | 0 |
| Freestanding heavy-duty steel shelving (48 in wide) (`steel-shelving-48`) | full | 7 | good, better, best | 6 |
| Extra-wide steel racking for long wall runs (77 in) (`steel-shelving-77`) | full | 3 | good, better, best | 2 |
| Ventilated wire shelving (`wire-shelving`) | full | 4 | good, better, best | 4 |
| Rust-proof plastic or resin shelving (`plastic-shelving`) | full | 5 | good, better | 4 |
| Wall-mounted shelves that keep the floor clear (`wall-shelves`) | full | 6 | good, better, best | 5 |
| Lidded totes for bulk and seasonal items (`lidded-totes`) | full | 6 | good, better, best | 5 |
| Wall-mounted open-front bin system (`wall-bin-system`) | full | 4 | good, better, best | 1 |
| Small-parts organizer or drawer cabinet (`small-parts-organizer`) | full | 4 | good, better, best | 4 |
| Magnetic wall strip for hand tools (`magnetic-tool-strip`) | full | 3 | good, better, best | 1 |
| Wall utility hooks (`utility-hooks`) | full | 4 | good, better, best | 2 |
| Hang ladders, cords and hoses off the floor (`ladder-cord-hooks`) | full | 5 | good, better, best | 3 |
| Store sports balls off the floor (`ball-storage`) | full | 4 | good, better, best | 3 |
| Store 1-2 golf bags and accessories (`golf-storage`) | full | 7 | good, better, best | 4 |
| Wall-mount skis, poles and snowboards (`ski-snowboard`) | full | 5 | good, better, best | 0 |
| Lift a kayak, canoe or SUP to the ceiling (`watercraft-ceiling`) | full | 3 | good, better | 1 |
| Wall-mount kayaks, canoes and paddleboards (`watercraft-wall`) | full | 5 | good, better, best | 3 |
| Camping chairs and folding gear on the wall (`camping-gear`) | full | 3 | good, better, best | 0 |
| Wall rail kit for tools, cords, hoses and ladders (`wall-rail-kit`) | full | 6 | good, better, best | 5 |
| Extend an existing wall rail (`rail-extension`) | full | 3 | good, better, best | 3 |
| Add hooks or bike hooks to an existing rail (`rail-accessories`) | full | 4 | good, better, best | 4 |
| Slatwall panels for a reconfigurable wall (`slatwall-panels`) | full | 6 | good, better, best | 6 |
| Hooks and baskets for slatwall (`slatwall-accessories`) | full | 3 | good, better, best | 2 |
| Pegboard tool wall above a workbench (`pegboard-wall`) | full | 5 | good, better, best | 5 |
| Pegboard hooks and holders (`pegboard-hooks`) | full | 3 | good, better, best | 3 |
| EGC one-car pressure wash (`egc-pressure-wash`) | service | 1 | - | 1 |
| EGC deep clean, priced by garage size (`egc-deep-clean`) | service | 4 | - | 4 |
| EGC non-toxic mouse trapping (`egc-mouse-trapping`) | service | 1 | - | 1 |
| EGC pest waste cleanup (`egc-pest-waste`) | service | 1 | - | 1 |
| EGC shelving unit, supplied and installed (`egc-shelving-unit`) | service | 3 | good, better, best | 3 |
| EGC labeled totes (`egc-labeled-totes`) | service | 1 | - | 1 |

12 full needs have no verified price on any option: `wall-cabinet`, `rolling-tool-chest`, `workbench-fixed`, `workbench-adjustable`, `fridge-freezer-zone`, `trash-recycling`, `kid-gear`, `pet-gear`, `overhead-rack-narrow`, `ceiling-hoist-motorized`, `ski-snowboard` and `camping-gear`. Re-check those prices first.

### Brands

79 brands: Akro-Mils, Ames, Armor All, Ball Claw, Barrina, Costway, Craftsman, Crawford, Delta Cycle, DEWALT, Eley, Elfa (The Container Store), Everbilt, Feedback Sports, FEUNLEM, FLEXIMOUNTS, Flexzilla, Flow Wall, Frigidaire, G-Floor, Garage Gator, GE, Generic, Giraffe Tools, Gladiator, Gorilla Rack, Greenmade, Harken, Hart, HDX, Home-it, Husky, Hykolity, HyLoft, Hyper Tough, Kobalt, Lithonia Lighting, LOVMOR, LTMATE, LUXRITE, MAG-MATE (Industrial Magnetics), Misopily, Monkey Bars, MonsterRAX, Muscle Rack, NewAge Products, ONRAX, Park Smart, PRO-SERIES, Proslat, RaceDeck, Racor, RAD Cycle Products, RAD Sportz, RAXGO, Rubbermaid, Rust-Oleum, SafeRacks, Saris, Sensethe, Seville Classics, Stalwart, Stanley, Steadyrack, Sterilite, storeWALL, StoreYourBoard, Sttoraboks, Suncast, Swisstrax, Tetra-Teknica, Thule, TrafficMaster, Trinity, Triton Products, U.S. General (Harbor Freight), Unbranded (Home Depot marketplace), URMMIY and Wall Control.

## How prices were observed

**No retailer or manufacturer product page was opened.** On 2026-09-27 the network egress proxy blocked every page fetch (Home Depot, Lowe's, Walmart, Amazon, Costco, manufacturer sites and cost guides), and the session's web-search budget ran out partway through. Every price in the catalog came from a **search-result snippet** (the short text a search engine shows under a link), and the audit pass could not re-open pages either. Snippets can lag live prices, show sale prices that have ended, or summarize several results at once.

So `priceVerified: true` means only that a snippet showed a price that can be tied to this exact product. It does not mean the price was confirmed at checkout. Each item records its evidence:

| `priceEvidence` | Meaning | Items |
|---|---|---:|
| `search_snippet` | Verified: a snippet price tied to this product. | 126 |
| `product_page` | Verified on the live product page. Used for future re-checks; none yet. | 0 |
| `unconfirmed_snippet` | A price was seen, but the audit could not tie it to this product (category page, wrong variant, conflicting snippets, out of stock). | 57 |
| `estimate` | No price was observed; the range is the researcher's typical-market estimate. | 56 |
| `egc_price_list` | EGC's own current walkthrough price. | 11 |

Other rules the data follows:

- Prices are integer cents per `priceUnit` (`retailPriceLowCents` and `retailPriceHighCents`). The pricing engine uses the **high** price as the conservative product cost unless the quote enters an actual cost.
- `priceVerifiedAt` is the `checkedOn` date of the snippet when the price is verified, and `null` otherwise. Every unverified item has a `verificationNote` explaining why.
- Every source keeps its URL, retailer, the observed price text and the date it was seen. There are 384 source records across 96 sites (Home Depot 93, Walmart 43, Amazon 33, Lowe's 31, StoreYourBoard 12, eBay 8, FLEXIMOUNTS 8, and others). Some sources are listing pages where no price appeared; they identify the product but do not support the price.
- Price ranges exclude dealer "list", "orig." and compare-at figures that an audit flagged as inflated, prices that needed a new store credit card, undated or year-old promotions, and prices for a different variant. A retailer's own current regular ("was") price is kept. Every corrected bound is a price that was actually observed; the build refused any number not present in an observation.
- No image URLs are stored anywhere; `validateCatalog` rejects image links and image fields.
- `installMinutes` is total technician minutes (person-minutes) per `priceUnit`, a whole number from 0 to 1440. A 2-person, 120-minute item means about 60 minutes on site. `crewSize` is the minimum crew the item needs: 2 for two-person lifts and for every EGC service (see [Legacy EGC services](#legacy-egc-services)).
- Small per-piece items are priced per batch, so one price unit always has whole install minutes: the two RaceDeck tiles per 10 tiles, Swisstrax per 10 sq ft, and the Everbilt shelf bracket per set of 3 (one 4 ft shelf). Their prices are the observed per-piece price times the batch size, as each `verificationNote` says. A 2-car floor of about 450 sq ft is 45 units.

## Audit outcome

Seven categories had an audit file: 49 spot checks and 132 red flags, 6 of which describe the audit method rather than one item. Every check and red flag was applied or explicitly reviewed; the build refused to finish if any audit finding had no decision. Shelving and wall systems had no audit file, so the same checks were applied by our own review. Each item records `auditStatus` and a list of `auditActions`, and `auditLog` in the JSON lists the item ids behind each count.

| Fix type (`auditLog.counts`) | Items |
|---|---:|
| Price marked unverified (`price_marked_unverified`) | 57 |
| Caveat recorded in `verificationNote` (`caveat_recorded`) | 58 |
| Other details corrected: model, name, capacity, pros and cons, zones, requirements (`details_corrected`) | 35 |
| Price range corrected to observed prices (`price_range_corrected`) | 27 |
| Safety notes written or extended (`safety_notes_written`) | 15 |
| Tier corrected (`tier_corrected`) | 13 |
| Reviewed, no change needed (`acknowledged_no_change`) | 12 |
| Source removed: different product (`source_removed_different_product`) | 11 |
| Source removed: fabricated-looking URL or unreliable seller (`source_removed_fabricated_or_unreliable`) | 10 |
| Two-person crew added (`two_person_crew_added`) | 8 |
| Availability changed to hidden or referral only (`availability_changed`) | 6 |
| Duplicate removed (`duplicate_removed`) | 4 |
| Source removed: wrong URL (`source_removed_url_wrong`) | 3 |
| Source removed: stale (`source_removed_stale`) | 3 |
| Source removed: category page (`source_removed_category_page`) | 2 |

`auditStatus` values: `fixed_per_audit` 125, `fixed_per_self_review` 13, `reviewed_no_change` 12, `no_findings` 47, `self_reviewed_no_findings` 42 and `legacy_service` 11.

Notable decisions:

- **Removed duplicates.** The Rubbermaid FastTrack vertical bike hook (model 1784463) appeared in bikes and wall systems; it was merged into the wall-systems item, which has an observed price, and now serves both needs. The SafeRacks 4x8 2-pack was removed (templated-looking Costco URL, exactly twice the single price); quote two single kits instead. Two generic camping items (27-gal totes and 5-tier shelving) duplicated the totes and shelving categories; the `camping-gear` need links to those needs instead.
- **Hidden, not quotable:** the ONRAX motorized lift (a placeholder with no price evidence), two no-name mower hangers with no load rating, and the Thule MultiLift (out of stock or unavailable everywhere, and no spec for heavy boats). `computeSellPriceCents` refuses hidden items.
- **Referral only:** the two professional coating referrals and the two Rust-Oleum DIY kits. EGC does not apply coatings, so these carry no install minutes or haul-away and cannot be priced into a quote.
- **Two-person installs:** when an audit said a second person is needed, `crewSize` became 2 and the one-technician `installMinutes` estimate was doubled, because both technicians are on the task. This is deliberately conservative; the owner can lower it. Items: Saris Cycle Glide add-on, Hykolity 8 ft lights, G-Floor ribbed mat, SafeRacks 2x8, both Gladiator GearBox cabinets, and two Husky workbenches.
- **Tier rationale instead of a re-tier.** Where an audit flagged a tier that does not follow price and the tier follows product grade, the reason is recorded in the item's `verificationNote` ("Tier rationale: ..."). This covers the power-equipment wall (the better YX912 4-pack at $67.84 against the best StoreYourBoard Omni rack, estimated at $50-$90), the Kobalt 54014 platform (best on its 500 lb rating, price estimated), and the Racor PHL-1R lift (good, a hand-crank lift whose estimated $360.99 high is still below the $400+ motorized better lifts). On the high prices the engine uses, the tiers in each of these needs still rise with price. The owner confirms these tiers before customer use.
- **Catalog-wide rules:** every two-person or overhead item must state how to mount or lift it, every two-person item must have `crewSize` 2, and referral-only items must have zero install minutes. `validateCatalog` enforces all three.
- **Normalization:** blank models became `null` (32), brand spellings were unified (11), "sold separately" text moved into `requires` (14), and verification text moved out of `priceUnit` (12). Haul-away flags missing from the research were defaulted: on for 34 items (floor bike racks, multi-bike racks and shelving) and off for 16 (hooks, hoists and wall racks). Four small per-piece items were re-priced per batch, and their haul-away is off (`haulaway_off_for_small_units`), because a $10 packaging charge on each tile batch or bracket set would be out of proportion; add packaging disposal to a quote as its own line if needed. `auditLog.normalizationItems` lists the item ids behind the haul-away and per-batch counts so they can be reviewed.

## Legacy EGC services

The existing walkthrough prices in `crew/gameplan.html` (`recommend()` and `estimatedJobMinutes()`, pricing version `2026-09-pest200-traps250`) are catalog service items, so today's prices stay identical. Since PRICE-SCRUB the page ships no prices: `functions/_lib/pricing-config.js` prices with these service items (plus the walkthrough's own base, fill, special-item and access tables and its labor-minute model) and `/api/pricing-config` serves them to staff who quote. The Worker never loads this JSON: `node scripts/generate-walkthrough-services.mjs --write` copies the legacy service items into the plain module `functions/_data/walkthrough-services.js`, because Wrangler 3 cannot bundle a JSON import. Changing a service's `fixedPriceCents` (with `legacy.amountDollars`) or `legacy.jobMinutes` here changes the walkthrough: regenerate the module (a test fails until it matches the catalog) and bump `WALKTHROUGH_PRICING_VERSION` (a test pins the tables to that label).

| Item | Price | When it applies today | Rounding | Job minutes at 2-person crew | `installMinutes` |
|---|---:|---|---|---:|---:|
| `svc-pressure-wash-1car` | $400.00 | Finish includes pressure wash and the garage is 1-car (`garageSizes` `['1']`) | Before | 60 | 120 |
| `svc-deep-clean-1car` | $125.00 | Deep clean, 1-car (`['1']`) | Before | 60 | 120 |
| `svc-deep-clean-2car` | $220.00 | Deep clean, 2-car and unknown size (`['2']`) | Before | 90 | 180 |
| `svc-deep-clean-3car` | $320.00 | Deep clean, 3-car (`['3']`) | Before | 120 | 240 |
| `svc-deep-clean-large` | $420.00 | Deep clean, larger ("other", `['other']`) | Before | 150 | 300 |
| `svc-shelving-unit-plastic` (good) | $349.00 | Per shelving unit, plastic | Before | 30 | 60 |
| `svc-shelving-unit-wood` (better) | $449.00 | Per shelving unit, wood + metal | Before | 30 | 60 |
| `svc-shelving-unit-metal` (best) | $499.00 | Per shelving unit, metal | Before | 30 | 60 |
| `svc-labeled-tote` | $21.50 | Per labeled 27-gallon tote | Before | 4 | 8 |
| `svc-mouse-trapping` | $250.00 | Non-toxic mouse trapping | After | 0 | 0 |
| `svc-pest-waste` | $200.00 | Pest waste hazard recorded | After | 0 | 0 |

Today's walkthrough total is: `max($450, round to the nearest $25(base + "before" services)) + "after" services`. `tests/catalog-pricing.test.mjs` runs `recommend()` from `crew/gameplan.html` and proves that the catalog prices reproduce it for every service, quantity and garage size. `installMinutes` is person-minutes: `estimatedJobMinutes()` adds elapsed minutes calibrated to a 2-person crew, so the catalog stores twice that, and every service has `crewSize` 2. The garage-size condition is machine-readable in `legacy.garageSizes`, which `optionsForNeed(..., { garageSize })` filters on; `legacy.condition` keeps the original rule as text.

Shelving tiers follow price: plastic is good, wood + metal is better and metal is best.

## Pricing model

For one unit (one `priceUnit`) of a product:

```
product  = customerSupplied ? 0 : (productCostCents ?? retailPriceHighCents)
minutes  = installMinutes
labor    = round(minutes × laborRateCents ÷ 60)
markup   = round(product × markupPct[category] ÷ 100)                (the default rate if the category is not listed)
disposal = includeDisposal and haulAwayApplicable ? disposalCentsPerItem : 0
unit     = product + labor + markup + disposal
```

A line of quantity `q` is every unit figure × `q`, so its total is always exactly `unit × q`.

- **Rounding:** all amounts are integer cents. `round` follows `roundingRule`: `half_up_cent` (the default) rounds a fractional cent half up, so 0.5 cent becomes 1 cent; `ceil_cent` rounds any fraction up. Each component is rounded once per unit and then multiplied, never rounded again on the line.
- **Customer-supplied products** cost 0 and carry no markup; labor and disposal still apply.
- **Service items** are their fixed price per unit, with no product, labor, markup or disposal split. They cannot be customer-supplied or cost-overridden.
- **Limits:** quantity is a whole number from 1 to 10,000, a line total is at most $1,000,000, and `installMinutes` is at most 1440 per unit. These match the LI-CORE line-item model.
- **Minimum job charge:** `applyMinimum(quoteTotalCents, settings)` raises the whole quote to `minimumJobCents`. It is never applied per line.
- Only `active` items can be priced. Hidden and referral-only items throw `catalog_item_not_quotable` (409).

Two functions return the same price in two shapes:

- `computeSellPriceCents(item, settings, { quantity, customerSupplied, productCostCents })` returns the **line** figures: `{ productCents, laborCents, laborMinutes, markupCents, disposalCents, fixedCents, totalCents, unitCents, quantity, priceVerified, priceEvidence }`. Every figure is the unit figure × quantity, `fixedCents` carries a fixed-price service, and `totalCents` is always the sum. `priceVerified` and `priceEvidence` come from the item, so a quote builder can flag or block a line whose price is only an `estimate` or an `unconfirmed_snippet`.
- `catalogLine(item, settings, options)` returns the fields of a LI-CORE line item (`functions/_lib/quote-model.js`, built in parallel): `{ kind, name, quantity, unitCents, totalCents, customerSupplied, split, durationMinutes }`. `split` is `{ productCents, laborCents, laborMinutes, markupCents, disposalCents }` for **one** unit and adds up to `unitCents`; it is `null` for a service. `durationMinutes` is the person-minutes per unit (`installMinutes`) for products and services alike. The quote builder adds `id`, `group`, `tier` and `catalog: { itemId, version: catalogVersion }`.

`tests/catalog-pricing.test.mjs` checks every active item at several quantities against the LI-CORE rules: the split adds up to the unit price, the total is the unit price × quantity, per-unit minutes are at most 1440, and only LI-CORE line fields are returned.

### Worked example (PLACEHOLDER settings, not real prices)

> These numbers use `pricing-settings.defaults.json`, whose values are **placeholders** ($75/hr labor, 20% markup, $10 disposal per unit, $450 minimum). They show how the math works. They are not prices to quote.

FLEXIMOUNTS GR48 Classic 4 x 8 overhead rack (`overhead-rack-fleximounts-gr48-classic-4x8`): high price $194.99, 120 installer-minutes, overhead category, haul-away yes.

| Line | Quantity 1 | Quantity 3 | Customer-supplied, quantity 1 |
|---|---:|---:|---:|
| Product | $194.99 | $584.97 | $0.00 |
| Labor (120 minutes × $75/hr per unit) | $150.00 | $450.00 | $150.00 |
| Markup 20% ($38.998 rounds half up to $39.00 per unit) | $39.00 | $117.00 | $0.00 |
| Disposal | $10.00 | $30.00 | $10.00 |
| **Line total** | **$393.99** | **$1,181.97** | **$160.00** |

At quantity 3 the markup is 3 × $39.00. Rounding 20% of the $584.97 line instead would give $116.99 and a $1,181.96 total that is not a whole-cent unit price × 3.

A small quote shows the minimum. Two Everbilt ladder hooks (`small-items-ladder-hook-everbilt-01219`, $2.48 each, 5 minutes each, no haul-away) are 2 × ($2.48 + $6.25 labor + $0.50 markup) = $18.46. Add one rack and the quote is $393.99 + $18.46 = $412.45, below the $450 placeholder minimum, so `applyMinimum` returns $450.00.

## What the owner must set before customer use

`pricing-settings.defaults.json` has `mustSetBeforeCustomerUse: true`, and `settingsReadyForCustomers()` returns `false` until the owner saves reviewed settings with it set to `false`. Customer-facing quotes must check this. Each value has a comment in the file with its basis:

| Setting | Placeholder | Basis | Owner decision |
|---|---|---|---|
| `laborRateCents` | 7500 ($75/hr per technician) | Fort Collins handyman $50-$90/hr; garage organizers $55-$75/hr; Denver Handy Co. $80/hr per person | EGC's billed rate per technician-hour. |
| `markupPct.default` and `byCategory` | 20% for every category | Contractor material markup 15%-35% (about 20% commodity, about 35% special-order) | Markup per category; consider more on cabinet systems and motorized lifts. |
| `minimumJobCents` | 45000 ($450) | Today's walkthrough minimum in `recommend()`; Colorado handyman minimums $100-$320 | The smallest install-only quote. |
| `includeDisposal`, `disposalCentsPerItem` | true, 1000 ($10 per unit) | Larimer landfill $22-$37 per pickup load (2026); haulers' minimums $60-$150 | Packaging haul-away charge, or off. |
| `depositPct` | 50 | Current policy (`walkthroughDeposit`, terms `2026-09-deposit50`) | Keep or change the deposit rule. |
| `roundingRule` | `half_up_cent` | Documented above | Keep half up, or `ceil_cent`. |

Also before customer use:

- Re-check the prices for the 12 needs with no verified option, then all 113 unverified items, before offering them.
- Review the doubled install minutes on the 8 two-person items.
- Confirm tier placements, especially where tiers follow product grade rather than price: Swisstrax floor tiles, the 77 in racks, the overhead lifts (including the Racor PHL-1R at good), the Kobalt 54014 platform at best, and the power-equipment wall (YX912 4-pack at better, StoreYourBoard Omni at best). Each of the last three records its "Tier rationale" in `verificationNote`.
- Review the haul-away defaults listed in `auditLog.normalizationItems.haulaway_defaulted_on` (34 items; all but the Everbilt bracket set now carry the per-unit packaging charge) and `haulaway_defaulted_off` (16 items).
- Confirm in production that `/functions/_data/garage-catalog.json` returns 404.

## Re-verification process

Prices go stale. `staleItems(catalog, now, days)` lists every item whose price was never verified or was verified more than `days` ago, counted in America/Denver calendar days from the injected `now`. `days` defaults to the catalog's `staleAfterDays` (90 in this version), so changing that one field changes the window. Items verified on 2026-09-27 become stale on 2026-12-27 (Denver). Never-verified items are listed first, then the oldest verifications.

To re-check an item:

1. Open the product page (or the retailer's page for the exact model and size) and read the current selling price. Ignore prices that need a new store card, list, compare-at or MSRP prices, and other variants.
2. Add or update a source: `url` (https, product page, no images), `retailer`, `observedPrice` with the exact text you saw, and `checkedOn` (the Denver date).
3. Update `retailPriceLowCents` and `retailPriceHighCents` in cents, set `priceVerified: true`, `priceVerifiedAt` to that `checkedOn`, `priceEvidence: "product_page"` (or `"search_snippet"` if only a search result showed it), and clear or update `verificationNote`.
4. If the product is gone or unsafe to quote, set `availability: "hidden"` with a note. Do not delete it or reuse its id, because saved quotes reference item ids.
5. Publish a new version: set `catalogVersion` to the date plus a counter (for example `2026-12-20.1`) and `generatedOn` to that date. No `checkedOn` may be later than `generatedOn`.
6. Run `node --test tests/catalog.test.mjs tests/catalog-pricing.test.mjs`. `validateCatalog` rejects missing sources, dates in the future, wrong coverage claims, image links and unsafe crew settings, and names the exact failing field.

The owner publishes the reviewed JSON through **Catalog & pricing → Publish**. The API atomically saves an immutable `catalogVersions/{version}`, updates the current pointer, and records its receipt and audit entry. Replaying a lost response uses the same request. A broken published record fails closed; it never silently falls back to old seed prices.

## Build and review a catalog quote

1. Enable catalog administration with `CATALOG_QUOTES_ENABLED=true` while keeping `mustSetBeforeCustomerUse=true`. This permits owner setup while product quote saves remain blocked. Review and save approved settings in **Pricing**, including labor, markup, minimum, packaging, deposit and rounding. Release those settings only after the owner decision and live storage checks. The settings version identifies those exact values permanently.
2. On **Items**, choose **Build catalog quote**. Enter the customer name, address and phone or email. Add up to 11 product selections; search and category filters show only active products with current verified prices.
3. Enter quantities and mark products the customer already owns. The server includes approved labor and packaging, removes product cost and markup for customer-supplied products, and applies the minimum once as its own visible line.
4. Choose **Review exact price**. The server checks the current catalog and settings versions. Review the total and configured deposit, then continue to **Save draft**. Saving alone does not notify the customer.
5. Review the saved quote and delivery mode. Confirm the separate send only when ready. Existing quote delivery, customer approval and money document flows use the saved amount and deposit.

The server recalculates every catalog line on save and rejects changed versions, substituted totals, unverified prices and stale products. Internal cost splits stay out of the customer preview. A saved quote retains its original prices until its validity date; later catalog changes do not silently reprice it. Turning the catalog switch off blocks new saves and sends while preserving exact receipts for already-completed requests.

An unconfirmed save keeps its original customer, selections, prices and request identity across reloads. Retry it unchanged before starting another quote. Sign-out clears local draft details, including protection against late network responses. This browser storage is temporary; save the draft before closing the browser session.

Focused verification: `node --test tests/catalog-quote.test.mjs tests/quote-draft.test.mjs tests/catalog-api.test.mjs tests/catalog-pricing.test.mjs tests/catalog-admin-ui.test.mjs`; browser checks: `python tests/browser/test_catalog_ui.py` and `python tests/browser/test_catalog_quote_ui.py`. The new composer also runs in WebKit using `EGC_TEST_BROWSER=webkit`.

## Stocked item standard costs (cost, not price)

Retail prices in this catalog are what a customer would pay a store. They are **never** used as EGC's cost. For items EGC keeps in stock (shelving, totes, racks), the owner enters a `standardUnitCostCents` per catalog `priceUnit` on the Hub screen **System → Stocked item costs** (owner only; managers can read it). It is stored server-side in `catalogStandardCosts/current`, with a receipt per save in `catalogStandardCostOperations/{requestId}` and an owner-visibility `hub_audit` entry in the same commit.

- Only active catalog products can take a cost. The list is generated from this file into `functions/_data/catalog-stock-items.js` (`node scripts/catalog-stock-items.mjs --write` after a catalog change; `tests/standard-costs.test.mjs` fails while it is stale). It carries no prices.
- An item without an entered cost is **unknown** (`null`), never $0 and never its retail price. Clearing a cost makes it unknown again.
- Job costing may use a standard cost only as a **provisional** cost for a stocked item used on a job, until a real field expense replaces it (`standardCostLine(await readStandardCosts(env), itemId, quantity)`).
