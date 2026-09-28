import * as z from "zod/v4";
import { CATALOG_TIERS } from "@egc/schemas";
// Generated from the Hub's versioned catalog by scripts/generate-catalog-index.mjs (ids, names,
// categories, brands and tiers only; never prices or costs). A root test fails when it drifts.
import generated from "./catalog-index.generated.json" with { type: "json" };

/** What conversation extraction may know about the catalog: enough to link a mention to an item. */
export type CatalogIndexItem = { id: string; name: string; category: string; brands: string[]; tiers: (typeof CATALOG_TIERS)[number][] };
/** skippedItems counts the entries left out because they were invalid, repeated an id or passed the item cap. */
export type CatalogIndex = { catalogVersion: string | null; items: CatalogIndexItem[]; skippedItems: number };
export const MAX_CATALOG_INDEX_ITEMS = 2000;

// The same limits as the Hub's validateCatalog (functions/_lib/catalog.js): a slug id, a name of up to 160 and a brand of
// up to 600 characters. Items are checked one at a time, so one bad item never empties the whole index.
const catalogIndexItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  name: z.string().trim().min(1).max(160),
  category: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  brands: z.array(z.string().trim().min(1).max(600)).max(10),
  tiers: z.array(z.enum(CATALOG_TIERS)).max(CATALOG_TIERS.length)
}).strict();
const catalogIndexSchema = z.object({
  catalogVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/).nullable(),
  items: z.array(z.unknown())
}).strict();
const EMPTY: CatalogIndex = { catalogVersion: null, items: [], skippedItems: 0 };

/** The valid items of an index (the first of a repeated id, at most MAX_CATALOG_INDEX_ITEMS), or the empty index
 * (catalogItemId is then always null) when the input is not an index at all. */
export function catalogIndexFrom(value: unknown): CatalogIndex {
  const parsed = catalogIndexSchema.safeParse(value);
  if (!parsed.success) return structuredClone(EMPTY);
  const ids = new Set<string>(), items: CatalogIndexItem[] = [];
  for (const raw of parsed.data.items) {
    const item = catalogIndexItemSchema.safeParse(raw);
    if (!item.success || ids.has(item.data.id) || items.length >= MAX_CATALOG_INDEX_ITEMS) continue;
    ids.add(item.data.id); items.push(item.data);
  }
  return { catalogVersion: parsed.data.catalogVersion, items, skippedItems: parsed.data.items.length - items.length };
}

let loaded: CatalogIndex | undefined;
/** The index of the versioned catalog shipped with this build. Each caller gets its own copy. */
export function loadCatalogIndex(): CatalogIndex {
  loaded ??= catalogIndexFrom(generated);
  return structuredClone(loaded);
}
