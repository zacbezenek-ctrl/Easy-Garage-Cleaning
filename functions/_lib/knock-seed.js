// The 24 canvassing neighborhoods. `where` selects the neighborhood's subdivision polygons in
// Larimer County's Parcels MapServer layer 1 (Subdivisions); platted is the platted lot count, so
// the imported address count will differ a little. Held neighborhoods stay locked for everyone
// until an admin clears them; a neighborhood whose city has no rule in settings is locked too.
export const NEIGHBORHOOD_SEED = Object.freeze([
  { name: 'Fossil Lake Ranch', platted: 774, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '0637%' OR SUBNUM LIKE '8081%'" },
  { name: 'Kechter Farm', platted: 416, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '0898%'" },
  { name: 'Westchase', platted: 410, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '0679%'" },
  { name: 'Observatory Village', platted: 432, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'WILLOW BROOK%'" },
  { name: 'Clarendon Hills', platted: 279, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1623%'" },
  { name: 'Miramont', platted: 173, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1850%' OR SUBNUM LIKE '1760%' OR SUBNUM LIKE '1797%'" },
  { name: 'Willow Springs', platted: 324, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'WILLOW SPRINGS%'" },
  { name: 'Huntington Hills', platted: 486, tier: 'Premium', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'HUNTINGTON HILLS%'" },
  { name: 'English Ranch', platted: 558, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'ENGLISH RANCH%'" },
  { name: 'Ridgewood Hills', platted: 836, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1851%'" },
  { name: 'Registry Ridge', platted: 518, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '8000%'" },
  { name: 'Trail Head', platted: 324, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '8132%'" },
  { name: 'Harvest Park', platted: 486, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '8014%'" },
  { name: 'Rigden Farm', platted: 686, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1997%'" },
  { name: 'Maple Hill', platted: 636, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '8098%'" },
  { name: 'Bucking Horse', platted: 205, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'BUCKING HORSE%'" },
  { name: 'Stetson Creek', platted: 292, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1833%'" },
  { name: 'Paragon Point', platted: 231, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNAME LIKE 'PARAGON POINT%'" },
  { name: 'Richards Lake', platted: 191, tier: 'Volume', status: 'open', city: 'fort-collins', where: "SUBNUM LIKE '1655%'" },
  { name: 'Highland Meadows', platted: 1335, tier: 'Premium', status: 'hold', holdReason: 'Windsor rules not checked', city: 'windsor', where: "SUBNAME LIKE 'HIGHLAND MEADOWS%'" },
  { name: 'Serratoga Falls', platted: 583, tier: 'Premium', status: 'hold', holdReason: 'Timnath rules not checked', city: 'timnath', where: "SUBNAME LIKE 'SERRATOGA%'" },
  { name: 'WildWing', platted: 324, tier: 'Premium', status: 'hold', holdReason: 'Timnath rules not checked', city: 'timnath', where: "SUBNAME LIKE 'WILDWING%'" },
  { name: 'Timnath Ranch', platted: 1261, tier: 'Volume', status: 'hold', holdReason: 'Timnath rules not checked', city: 'timnath', where: "SUBNAME LIKE 'TIMNATH RANCH%'" },
  { name: 'Harmony Club', platted: 470, tier: 'Premium', status: 'hold', holdReason: 'Private golf community, access not confirmed', city: 'timnath', where: "SUBNUM LIKE '5006%'" },
]);

export const neighborhoodId = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function seedNeighborhoodDocs(nowIso) {
  return NEIGHBORHOOD_SEED.map(seed => ({
    id: neighborhoodId(seed.name),
    name: seed.name,
    tier: seed.tier,
    status: seed.status,
    holdReason: seed.holdReason || '',
    cityKey: seed.city,
    plattedCount: seed.platted,
    countyWhere: seed.where,
    importedCount: 0,
    unitCount: 0,
    importedAt: null,
    statusChangedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}
