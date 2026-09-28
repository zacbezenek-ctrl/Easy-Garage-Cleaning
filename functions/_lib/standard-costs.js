/** Owner-entered standard unit costs for stocked catalog products (FUN-19). Server-only collections:
 *   catalogStandardCosts/current               {schemaVersion:1, catalogVersion, items:[{itemId, standardUnitCostCents,
 *                                               updatedAt, updatedBy}], updatedAt, updatedBy, requestId}
 *   catalogStandardCostOperations/<requestId>  receipts {action, requestId, fingerprint, actorId, at, changedItemIds}
 * A standard cost is what EGC pays per catalog priceUnit for an item it keeps in stock (shelving, totes,
 * racks). Job costing may use it only as a provisional cost for a stocked item used on a job, until an actual
 * expense replaces it. It is never derived from the catalog's retail prices or a quote's product split: an
 * item without an owner-entered cost is unknown (null), never $0 and never its retail price.
 * The item list comes from the active products of the seed catalog (functions/_data/catalog-stock-items.js).
 * revision is the Firestore updateTime. Managers read; only the owner writes, and every write commits its
 * receipt and an owner-visibility hub_audit entry in the same Firestore commit. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { STOCK_CATALOG_VERSION, STOCK_CATEGORIES, STOCK_ITEMS } from '../_data/catalog-stock-items.js';

export const STANDARD_COSTS = 'catalogStandardCosts', STANDARD_COST_OPERATIONS = 'catalogStandardCostOperations', CURRENT = 'current';
export const STANDARD_COST_ACTION = 'standard_costs.set';
// Catalog per-item ceiling ($100,000), and at most this many items per save.
export const STANDARD_COST_MAX_CENTS = 10000000, STANDARD_COST_CHANGES = 100;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const STOCK = new Map(STOCK_ITEMS.map(([id, name, category, priceUnit]) => [id, { id, name, category, priceUnit }]));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `standard_cost_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const validCents = value => Number.isSafeInteger(value) && value >= 1 && value <= STANDARD_COST_MAX_CENTS;
const conflict = () => fail('revision_conflict', 'Standard costs changed while you were editing. Your changes are kept; load the latest costs and save again.', 409);
const outcomeUnknown = () => fail('outcome_unknown', 'The save could not be confirmed. Retry the same save to check whether it was applied; it will not be applied twice.', 503);

export function requireStandardCostViewer(session) {
  if (!session?.user) throw fail('sign_in_required', 'Sign in to review stocked item costs.', 401);
  if (!hasBusinessAccess(session)) throw fail('forbidden', 'Only operations managers can review stocked item costs.', 403);
}
export function requireStandardCostOwner(session) {
  requireStandardCostViewer(session);
  if (!isHubOwner(session)) throw fail('owner_required', 'Only the owner can set stocked item costs.', 403);
}

function decode(document, collection, id) {
  const name = typeof document?.name === 'string' ? document.name : '';
  if (!name.endsWith(`/documents/${collection}/${id}`) || typeof document.updateTime !== 'string' || !document.updateTime || document.fields !== undefined && !plain(document.fields)) throw fail('storage_incomplete', 'Standard-cost storage returned a record without a verifiable identity or revision. Retry.', 503);
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

/** read(collection,id) => row|null and commit(writes) over Firestore REST, like dispatchStorage: a write with a
 * revision updates under currentDocument.updateTime, one without is create-only. A stale precondition (409,
 * 412, 404, or 400 FAILED_PRECONDITION) is standard_cost_revision_conflict; a lost or 5xx response is
 * standard_cost_outcome_unknown, retried with the same requestId. */
export function standardCostStorage(env, fetcher = firestoreFetch) {
  async function send(url, options = {}) {
    try { return await fetcher(env, url, { ...options, signal: AbortSignal.timeout(20000) }); } catch { return null; }
  }
  return {
    async read(collection, id) {
      const response = await send(`${BASE}/${collection}/${encodeURIComponent(id)}`);
      if (response?.status === 404) return null;
      if (!response?.ok) throw fail('unavailable', 'Standard costs could not be loaded. Retry.', 503);
      return decode(await response.json().catch(() => null), collection, id);
    },
    async commit(writes) {
      const body = JSON.stringify({ writes: writes.map(write => ({
        update: { name: `${ROOT}/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) },
        ...(write.revision ? { updateMask: { fieldPaths: Object.keys(write.patch) } } : {}),
        currentDocument: write.revision ? { updateTime: write.revision } : { exists: false },
      })) });
      const response = await send(`${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!response) throw outcomeUnknown();
      if (response.ok) return;
      const status = (await response.json().catch(() => null))?.error?.status;
      if ([404, 409, 412].includes(response.status) || response.status === 400 && status === 'FAILED_PRECONDITION') throw conflict();
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) throw fail('storage_rejected', 'Standard-cost storage refused this change. Nothing was saved.', 503);
      throw outcomeUnknown();
    },
  };
}

// A stored record that fails verification fails closed: no cost is guessed.
function storedCosts(row) {
  if (!row) return { revision: null, catalogVersion: null, updatedAt: null, updatedBy: null, items: new Map() };
  const broken = () => fail('storage_invalid', 'The saved standard costs failed verification. Nothing was changed; the owner must re-save them before they can be used.', 503);
  if (row.schemaVersion !== 1 || !Array.isArray(row.items) || row.items.length > STOCK.size + 500) throw broken();
  const items = new Map();
  for (const item of row.items) {
    if (!plain(item) || typeof item.itemId !== 'string' || !SLUG.test(item.itemId) || items.has(item.itemId) || !validCents(item.standardUnitCostCents) || typeof item.updatedAt !== 'string' || !INSTANT.test(item.updatedAt) || typeof item.updatedBy !== 'string' || !item.updatedBy) throw broken();
    items.set(item.itemId, { itemId: item.itemId, standardUnitCostCents: item.standardUnitCostCents, updatedAt: item.updatedAt, updatedBy: item.updatedBy });
  }
  return { revision: row.revision, catalogVersion: typeof row.catalogVersion === 'string' ? row.catalogVersion : null, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null, updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null, items };
}

/** The saved standard costs for server-side job costing: {revision, catalogVersion, items: Map(itemId =>
 * {itemId, standardUnitCostCents, updatedAt, updatedBy})}. Empty (revision null) until the owner saves any. */
export async function readStandardCosts(env, { store = standardCostStorage(env) } = {}) {
  return storedCosts(await store.read(STANDARD_COSTS, CURRENT));
}

/** Provisional cost of `quantity` catalog priceUnits of a stocked item. costs is readStandardCosts() output.
 * An item without an owner-entered cost is status 'unknown' with totalCents null (never retail, never 0). */
export function standardCostLine(costs, itemId, quantity = 1) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) throw fail('invalid', 'A stocked item quantity must be a whole number from 1 to 10,000.', 400);
  const unit = costs?.items instanceof Map ? costs.items.get(itemId)?.standardUnitCostCents ?? null : null;
  if (!validCents(unit)) return { itemId, quantity, standardUnitCostCents: null, totalCents: null, status: 'unknown', reason: 'standard_cost_unset', source: 'standard_cost' };
  return { itemId, quantity, standardUnitCostCents: unit, totalCents: unit * quantity, status: 'provisional', reason: 'standard_cost', source: 'standard_cost' };
}

export async function standardCostOverview(store, session, now = new Date()) {
  requireStandardCostViewer(session);
  const costs = storedCosts(await store.read(STANDARD_COSTS, CURRENT));
  const items = STOCK_ITEMS.map(([id, name, category, priceUnit]) => { const saved = costs.items.get(id); return { id, name, category, priceUnit, standardUnitCostCents: saved?.standardUnitCostCents ?? null, updatedAt: saved?.updatedAt ?? null, updatedBy: saved?.updatedBy ?? null }; });
  // Costs for items no longer active in the catalog stay visible so the owner can clear them.
  const retired = [...costs.items.values()].filter(item => !STOCK.has(item.itemId)).map(item => ({ id: item.itemId, standardUnitCostCents: item.standardUnitCostCents, updatedAt: item.updatedAt, updatedBy: item.updatedBy }));
  return {
    ok: true, authority: 'employee_hub', basis: 'standard_unit_cost', asOf: (now instanceof Date ? now : new Date(now)).toISOString(),
    catalogVersion: STOCK_CATALOG_VERSION, revision: costs.revision, updatedAt: costs.updatedAt, updatedBy: costs.updatedBy,
    categories: STOCK_CATEGORIES.map(([id, label]) => ({ id, label })), items, retired,
    coverage: { set: items.filter(item => item.standardUnitCostCents !== null).length, total: items.length }, canEdit: isHubOwner(session),
  };
}

function readChanges(input, known) {
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > STANDARD_COST_CHANGES) throw fail('request_invalid', `Save 1 to ${STANDARD_COST_CHANGES} item costs at a time.`);
  const seen = new Set();
  return input.changes.map(change => {
    if (!plain(change) || Object.keys(change).some(key => !['itemId', 'standardUnitCostCents'].includes(key)) || !Object.hasOwn(change, 'standardUnitCostCents')) throw fail('request_invalid', 'Each change needs an item and its unit cost (or null to clear it).');
    if (typeof change.itemId !== 'string' || seen.has(change.itemId) || !(STOCK.has(change.itemId) || change.standardUnitCostCents === null && known.has(change.itemId))) throw fail('item_invalid', 'Choose each stocked catalog item once.', 400, { itemId: String(change.itemId).slice(0, 80) });
    if (change.standardUnitCostCents !== null && !validCents(change.standardUnitCostCents)) throw fail('amount_invalid', `Enter a unit cost from $0.01 to $${(STANDARD_COST_MAX_CENTS / 100).toLocaleString('en-US')} in whole cents.`, 400, { itemId: change.itemId });
    seen.add(change.itemId);
    return change;
  });
}

/** POST {action:'standard_costs.set', requestId, expectedRevision, changes:[{itemId, standardUnitCostCents|null}], reason?}
 * (owner). expectedRevision is the overview revision (null before the first save); null clears an item's
 * cost. The same requestId replays the saved result; with a different body it is a 409. */
export async function mutateStandardCosts(store, session, input, now = new Date().toISOString()) {
  requireStandardCostOwner(session);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'changes', 'reason'].includes(key))) throw fail('request_invalid', 'The standard-cost request contains unsupported fields. Reload and try again.');
  if (input.action !== STANDARD_COST_ACTION) throw fail('request_invalid', 'Choose a supported standard-cost action.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'A unique request ID is required. Reload and try again.');
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80)) throw fail('request_invalid', 'The current standard-cost version is required. Reload and try again.');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) throw fail('request_invalid', 'Keep the note to 500 characters.');
  const requestId = input.requestId.toLowerCase(), fingerprint = await digest(canonical({ actor: String(session.user).toLowerCase(), input: { ...input, requestId } }));
  const receipt = await store.read(STANDARD_COST_OPERATIONS, requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different save. Reload before saving again.', 409);
    return { ...await standardCostOverview(store, session, now), requestId, replayed: true };
  }
  const current = await store.read(STANDARD_COSTS, CURRENT), costs = storedCosts(current);
  if (costs.revision !== input.expectedRevision) throw conflict();
  const changes = readChanges(input, costs.items), items = new Map(costs.items), before = {}, after = {};
  for (const change of changes) {
    const previous = items.get(change.itemId)?.standardUnitCostCents ?? null;
    if (previous === change.standardUnitCostCents) continue;
    before[change.itemId] = previous; after[change.itemId] = change.standardUnitCostCents;
    if (change.standardUnitCostCents === null) items.delete(change.itemId);
    else items.set(change.itemId, { itemId: change.itemId, standardUnitCostCents: change.standardUnitCostCents, updatedAt: now, updatedBy: session.user });
  }
  const changedItemIds = Object.keys(after);
  if (!changedItemIds.length) throw fail('no_change', 'These costs are already saved. Change at least one before saving.');
  const patch = { schemaVersion: 1, catalogVersion: STOCK_CATALOG_VERSION, items: [...items.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)), updatedAt: now, updatedBy: session.user, requestId };
  const audit = auditWrite({ actor: { id: session.user, kind: 'human', role: session.role }, via: 'hub', action: 'catalog.standard_costs.set', entity: { collection: STANDARD_COSTS, id: CURRENT }, before, after, requestId, reason: input.reason?.trim() || null, visibility: 'owner', now });
  await store.commit([
    { collection: STANDARD_COSTS, id: CURRENT, revision: costs.revision, patch },
    { collection: STANDARD_COST_OPERATIONS, id: requestId, patch: { action: STANDARD_COST_ACTION, requestId, fingerprint, actorId: session.user, at: now, changedItemIds } },
    { collection: audit.collection, id: audit.id, patch: audit.patch },
  ]);
  return { ...await standardCostOverview(store, session, now), requestId, replayed: false };
}
