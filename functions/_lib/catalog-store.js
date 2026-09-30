/** Garage catalog and owner pricing settings in Firestore (P2-03). Server-only collections:
 *   catalogVersions/current        the published pointer {version, basedOnVersion, sha256, itemCount,
 *                                  publishedAt, publishedBy, requestId}
 *   catalogVersions/<YYYY-MM-DD.N> an immutable, create-only snapshot {catalogVersion, basedOnVersion,
 *                                  catalogJson, sha256, itemCount, generatedOn, publishedAt, publishedBy, requestId}
 *   pricingSettings/current        {settings, settingsVersion, readyForCustomers, updatedAt, updatedBy, requestId}
 *   pricingSettingsVersions/<label> a create-only copy of every saved settings version {settingsVersion, settings,
 *                                  readyForCustomers, savedAt, savedBy, requestId}: a label names one set of values
 *                                  for good, so the settingsVersion a quote records resolves to what priced it
 *   catalogOperations/<requestId>  receipts {action, fingerprint, actorId, requestId, at, result}
 * With no pointer the seed catalog (functions/_data/garage-catalog.json) is the published catalog, and with
 * no settings document the placeholder defaults apply (mustSetBeforeCustomerUse: true, internal use only).
 * A stored record that is malformed or fails verification fails closed (503) and never falls back to a seed.
 * revision is the Firestore updateTime. Only the owner writes, and every write commits its receipt and a
 * hub_audit entry in the same Firestore commit.
 * CPU: a catalog is validated once, when it is published, and the pointer records the sha256 of its JSON. A read
 * checks the snapshot against that hash once per isolate and then serves the frozen catalog from memory while the
 * pointer names the same version and hash, so a warm read fetches only the pointer and the settings. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { CATALOG_SCHEMA_VERSION, catalogLinePricer, settingsReadyForCustomers, staleItems, validateCatalog, validatePricingSettings } from './catalog.js';
import { denverToday } from './dispatch-time.js';
import { SEED_CATALOG_JSON, SEED_SETTINGS_JSON } from '../_data/catalog-seed.js';

export const CATALOG_VERSIONS = 'catalogVersions', PRICING_SETTINGS = 'pricingSettings', PRICING_SETTINGS_VERSIONS = 'pricingSettingsVersions', CATALOG_OPERATIONS = 'catalogOperations', CURRENT = 'current';
export const CATALOG_ACTIONS = Object.freeze(['settings.update', 'catalog.publish']);
// A Firestore document holds at most 1 MiB and the compact catalog JSON is one string field of its snapshot.
export const MAX_CATALOG_BYTES = 900000;
export const catalogQuotesEnabled = env => env?.CATALOG_QUOTES_ENABLED === 'true';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Items a non-internal viewer may see: no product cost, retail observations, sources, audit notes or labor time.
const PUBLIC_ITEM_FIELDS = ['id', 'kind', 'category', 'subcategory', 'needs', 'zones', 'tier', 'availability', 'name', 'priceUnit', 'description', 'brand', 'model', 'genericSpec', 'dimensions', 'weightCapacity', 'requires', 'pros', 'cons', 'bestFor', 'installNotes', 'installRequirements', 'crewSize', 'safetyNotes', 'priceVerified', 'priceVerifiedAt', 'sqFtPerUnit'];
const PUBLIC_CATALOG_FIELDS = ['schemaVersion', 'catalogVersion', 'generatedOn', 'currency', 'staleAfterDays', 'zones', 'categories', 'needs'];
// Left out of the default internal view and returned with view=full: the audit log, price sources, verification
// notes and item audit notes are about a third of the catalog and only the publish editor needs them.
const DETAIL_CATALOG_FIELDS = ['auditLog'], DETAIL_ITEM_FIELDS = ['sources', 'verificationNote', 'auditStatus', 'auditActions'];
const encoder = new TextEncoder();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value ? value : null;
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `catalog_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digestHex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = value => digestHex(encoder.encode(value));
const frozen = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(frozen); } return value; };
// details name the revision or version the owner re-saves or republishes over to repair the record.
const storageInvalid = (what, details) => fail('storage_invalid', `The saved ${what} failed verification. Nothing was changed; the owner must republish or re-save it before pricing can continue.`, 503, details);
const outcomeUnknown = () => fail('outcome_unknown', 'The save could not be confirmed. Retry the same request to safely check whether it saved.', 503);
const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const conflict = () => fail('revision_conflict', 'The catalog or pricing settings changed while you were editing. Reload and review the latest version.', 409);
function keys(value, allowed) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra !== undefined) throw fail('request_invalid', 'The catalog request contains unsupported fields. Reload and try again.', 400, { field: extra.slice(0, 80) });
}
// Catalog versions are YYYY-MM-DD.N: later date first, then the higher release number.
function compareVersions(a, b) {
  const [dateA, releaseA] = a.split('.'), [dateB, releaseB] = b.split('.');
  return dateA === dateB ? Number(releaseA) - Number(releaseB) : dateA < dateB ? -1 : 1;
}

// The seed module is the shipped JSON (pinned by tests/catalog-api.test.mjs), which tests/catalog.test.mjs
// validates, so it is parsed but not validated again at runtime.
let seed = null;
function seeds() {
  if (!seed) seed = { catalog: frozen(JSON.parse(SEED_CATALOG_JSON)), settings: frozen(JSON.parse(SEED_SETTINGS_JSON)) };
  return seed;
}
export const seedCatalog = () => seeds().catalog;
export const seedPricingSettings = () => seeds().settings;

function decode(document, collection, id) {
  const name = typeof document?.name === 'string' ? document.name : '';
  if (!name.endsWith(`/documents/${collection}/${id}`) || typeof document.updateTime !== 'string' || !document.updateTime || document.fields !== undefined && !plain(document.fields)) throw fail('storage_incomplete', 'The catalog storage returned a record without a verifiable identity or revision. Retry.', 503);
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

// Firestore's answer for a document that does not exist: 'Document "<name>" not found.' (the emulator writes
// the name in parentheses). Any other 404, such as a missing database or project, fails closed rather than
// serving the seed catalog and placeholder settings.
function documentMissing(body, collection, id) {
  const message = body?.error?.status === 'NOT_FOUND' && typeof body.error.message === 'string' ? body.error.message : '';
  const name = /^Document (?:"(.+)"|\((.+)\)) not found\.?$/.exec(message);
  return Boolean(name) && (name[1] ?? name[2]).endsWith(`/documents/${collection}/${id}`);
}

/** read(collection,id) => row|null and commit(writes) over Firestore REST, like dispatchStorage. A write with a
 * revision updates under currentDocument.updateTime (a stale or deleted document is 400 FAILED_PRECONDITION);
 * without one it is create-only (409 ALREADY_EXISTS). Those and 412 are catalog_revision_conflict; a lost,
 * ABORTED, other 409, 408, 429 or 5xx response is catalog_outcome_unknown, retried with the same requestId; any
 * other refusal, a 404 for a missing database included, is catalog_storage_rejected. */
export function catalogStorage(env, fetcher = firestoreFetch) {
  async function send(url, options = {}) {
    try { return await fetcher(env, url, { ...options, signal: AbortSignal.timeout(20000) }); } catch { return null; }
  }
  return {
    async read(collection, id) {
      const response = await send(`${BASE}/${collection}/${encodeURIComponent(id)}`);
      if (response?.status === 404 && documentMissing(await response.json().catch(() => null), collection, id)) return null;
      if (!response?.ok) throw fail('storage_unavailable', 'The catalog could not be loaded. Retry.', 503);
      return decode(await response.json().catch(() => null), collection, id);
    },
    async commit(writes) {
      const body = JSON.stringify({ writes: writes.map(write => ({
        update: { name: `${ROOT}/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) },
        updateMask: { fieldPaths: Object.keys(write.patch) },
        currentDocument: write.revision ? { updateTime: write.revision } : { exists: false },
      })) });
      const response = await send(`${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!response) throw outcomeUnknown();
      if (response.ok) return response.json().catch(() => ({}));
      const status = (await response.json().catch(() => null))?.error?.status;
      if (response.status === 412 || [400, 409].includes(response.status) && ['FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(status)) throw conflict();
      if (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)) throw fail('storage_rejected', 'Catalog storage refused this change. Nothing was saved.', 503);
      throw outcomeUnknown();
    },
  };
}

// Published catalogs this isolate has verified, by version and content hash. Snapshots are create-only and
// server-only, so a pointer that names the same version and hash names the same catalog. Two cover the current
// version and the one it replaced (a parsed catalog holds about 1 MB).
const verifiedCatalogs = new Map(), CACHED_CATALOGS = 2;
// validateCatalog ran when the catalog was published and the hash proves this is that JSON; this cheap check
// refuses a snapshot re-signed by hand into something reads and pricing cannot use.
const catalogShaped = (catalog, pointer) => plain(catalog) && catalog.schemaVersion === CATALOG_SCHEMA_VERSION && catalog.catalogVersion === pointer.version && catalog.generatedOn === pointer.version.slice(0, 10)
  && Number.isSafeInteger(catalog.staleAfterDays) && ['zones', 'categories', 'needs', 'items'].every(key => Array.isArray(catalog[key])) && catalog.items.length === pointer.itemCount && catalog.items.every(item => plain(item) && typeof item.id === 'string');
async function publishedCatalog(store, pointer, cache) {
  if (!pointer) {
    const catalog = seedCatalog();
    return { catalog, publication: { source: 'seed', version: catalog.catalogVersion, revision: null, basedOnVersion: null, sha256: null, itemCount: catalog.items.length, publishedAt: null, publishedBy: null } };
  }
  // details.currentVersion is the basedOnVersion the owner publishes over to repair it (null: the pointer's is unreadable).
  if (typeof pointer.version !== 'string' || !VERSION.test(pointer.version)) throw storageInvalid('catalog', { currentVersion: null });
  const broken = () => storageInvalid('catalog', { currentVersion: pointer.version }), key = `${pointer.version}:${pointer.sha256}`;
  if (typeof pointer.sha256 !== 'string' || !HEX64.test(pointer.sha256)) throw broken();
  let catalog = cache.get(key);
  if (!catalog) {
    const snapshot = await store.read(CATALOG_VERSIONS, pointer.version);
    if (!snapshot || snapshot.catalogVersion !== pointer.version || snapshot.sha256 !== pointer.sha256 || typeof snapshot.catalogJson !== 'string' || await sha256(snapshot.catalogJson) !== pointer.sha256) throw broken();
    try { catalog = JSON.parse(snapshot.catalogJson); } catch { throw broken(); }
    if (!catalogShaped(catalog, pointer)) throw broken();
    if (cache.size >= CACHED_CATALOGS) cache.delete(cache.keys().next().value);
    cache.set(key, frozen(catalog));
  }
  return { catalog, publication: { source: 'firestore', version: pointer.version, revision: pointer.revision, basedOnVersion: text(pointer.basedOnVersion), sha256: pointer.sha256, itemCount: catalog.items.length, publishedAt: text(pointer.publishedAt), publishedBy: text(pointer.publishedBy) } };
}

function pricingState(row) {
  if (!row) return { settings: seedPricingSettings(), settingsState: { source: 'defaults', revision: null, updatedAt: null, updatedBy: null } };
  let settings;
  try { settings = validatePricingSettings(row.settings); } catch { settings = null; }
  if (!settings || row.settingsVersion !== settings.settingsVersion) throw storageInvalid('pricing settings', { currentRevision: row.revision });
  return { settings, settingsState: { source: 'firestore', revision: row.revision, updatedAt: text(row.updatedAt), updatedBy: text(row.updatedBy) } };
}

/** The published catalog and the pricing settings in force: {catalog, publication, settings, settingsState}. The
 * catalog is frozen and shared; cache is this isolate's verified catalogs (tests pass a new Map for a cold isolate). */
export async function readCatalogState(store, { cache = verifiedCatalogs } = {}) {
  const [pointer, settingsRow] = await Promise.all([store.read(CATALOG_VERSIONS, CURRENT), store.read(PRICING_SETTINGS, CURRENT)]);
  const { settings, settingsState } = pricingState(settingsRow);
  return { ...await publishedCatalog(store, pointer, cache), settings, settingsState };
}

const catalogOwner = session => isHubOwner(session) && session.role === 'owner';
// Owner and managers see the internal cost split. The walkthrough/sales role has no catalog capability yet (P2-12).
export function requireCatalogViewer(session) {
  if (!session) throw fail('sign_in_required', 'Sign in to the Employee Hub to open the pricing catalog.', 401);
  if (!hasBusinessAccess(session) || !['owner', 'manager'].includes(session.role)) throw fail('forbidden', 'Only an operations manager or the owner can open the pricing catalog.', 403);
  return { internal: true, owner: catalogOwner(session) };
}
export function requireCatalogOwner(session) {
  if (!session) throw fail('sign_in_required', 'Sign in to the Employee Hub to change the pricing catalog.', 401);
  if (!catalogOwner(session)) throw fail('owner_required', 'Only the owner can change pricing settings or publish the catalog.', 403);
}

// One unit of every item (catalogLine, quantity 1). Referral-only and hidden items are not quotable.
function itemPrice(item, priceLine, stale, internal) {
  let line;
  try { line = priceLine(item); }
  catch (error) {
    if (error?.code === 'catalog_item_not_quotable') return { quotable: false, reason: item.availability, stale };
    throw fail('pricing_unavailable', 'The catalog could not be priced with the saved settings. Nothing was changed; review the settings.', 503);
  }
  const price = { quotable: true, stale, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents, customerSupplied: line.customerSupplied };
  return internal ? { ...price, durationMinutes: line.durationMinutes, split: line.split } : price;
}

// A catalog's views, prices and stale flags depend only on the viewer class, the settings values and the Denver
// day, so an isolate builds each once per shared (frozen) catalog and serves it frozen. A caller's own mutable
// catalog is projected afresh.
const projections = new WeakMap();
function projected(catalog, key, build) {
  if (!Object.isFrozen(catalog)) return build();
  let entries = projections.get(catalog);
  if (!entries) projections.set(catalog, entries = new Map());
  if (!entries.has(key)) { if (entries.size >= 32) entries.clear(); entries.set(key, frozen(build())); }
  return entries.get(key);
}

/** The GET projection. internal (owner/manager) adds the catalog with product costs, the settings values and the
 * per-item cost split and minutes, and with full the complete document (audit log, sources, verification and
 * audit notes) the publish editor starts from; everyone else gets the allowlisted fields. */
export function projectCatalogOverview({ catalog, publication, settings, settingsState }, { internal = false, full = false, now } = {}) {
  const items = internal ? catalog.items : catalog.items.filter(item => item.availability !== 'hidden');
  const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const view = () => !internal ? { ...pick(catalog, PUBLIC_CATALOG_FIELDS), items: items.map(item => pick(item, PUBLIC_ITEM_FIELDS)) } : full ? catalog : { ...omit(catalog, DETAIL_CATALOG_FIELDS), items: items.map(item => omit(item, DETAIL_ITEM_FIELDS)) };
  const priced = () => {
    const ids = new Set(items.map(item => item.id)), stale = staleItems(catalog, now).filter(entry => ids.has(entry.id)), staleIds = new Set(stale.map(entry => entry.id));
    const priceLine = catalogLinePricer(settings);
    return { prices: Object.fromEntries(items.map(item => [item.id, itemPrice(item, priceLine, staleIds.has(item.id), internal)])), stale: { afterDays: catalog.staleAfterDays, count: stale.length, items: internal ? stale : stale.map(({ id, reason }) => ({ id, reason })) } };
  };
  const at = now instanceof Date ? now : new Date(now), day = Number.isFinite(at.getTime()) ? denverToday(at) : null;
  const { prices, stale } = day ? projected(catalog, `prices:${internal}:${day}:${JSON.stringify(settings)}`, priced) : priced();
  return {
    catalog: projected(catalog, `view:${internal}:${full}`, view),
    publication: internal ? publication : { source: publication.source, version: publication.version, publishedAt: publication.publishedAt },
    settings: { revision: settingsState.revision, source: settingsState.source, settingsVersion: settings.settingsVersion, readyForCustomers: settingsReadyForCustomers(settings), ...(internal ? { updatedAt: settingsState.updatedAt, updatedBy: settingsState.updatedBy, values: settings } : {}) },
    prices, stale,
  };
}

export async function catalogOverview(store, session, now = new Date(), { full = false, cache } = {}) {
  const viewer = requireCatalogViewer(session), detail = viewer.internal && full;
  const state = await readCatalogState(store, { cache });
  return { ok: true, authority: 'employee_hub', enabled: true, asOf: now.toISOString(), view: detail ? 'full' : 'summary', ...projectCatalogOverview(state, { internal: viewer.internal, full: detail, now }), viewer: { id: session.user, role: session.role, internal: viewer.internal, canEditSettings: viewer.owner, canPublish: viewer.owner } };
}

async function priorReceipt(store, id, fingerprint, actor, action) {
  const receipt = await store.read(CATALOG_OPERATIONS, id);
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor || receipt.action !== action) throw fail('idempotency_conflict', 'This request ID already saved a different catalog change. Reload, review the latest catalog and make the change again.', 409);
  return receipt;
}

// A lost response or a conflict may hide our own commit (a retry racing the original): the receipt decides.
// => {committed: the commit response} or {recovered: the saved result}.
async function commitOrRecover(store, writes, recover) {
  try { return { committed: await store.commit(writes) }; }
  catch (error) {
    if (!['catalog_outcome_unknown', 'catalog_revision_conflict'].includes(error?.code)) throw error;
    const recovered = await recover().catch(() => null);
    if (recovered) return { recovered };
    throw error;
  }
}

// current is false (and revision null) only when a newer save replaced this one before it could be read back.
function settingsResult(row, requestId, replayed, current = true) {
  const { settings, settingsState } = pricingState(row);
  return { ok: true, authority: 'employee_hub', action: 'settings.update', requestId, replayed, settings: { revision: settingsState.revision, current, source: 'firestore', settingsVersion: settings.settingsVersion, readyForCustomers: settingsReadyForCustomers(settings), updatedAt: settingsState.updatedAt, updatedBy: settingsState.updatedBy, values: settings } };
}

async function updateSettings(store, session, input, now, actor) {
  keys(input, ['action', 'requestId', 'expectedRevision', 'settings', 'confirmCustomerUse']);
  if (!Object.hasOwn(input, 'expectedRevision') || input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 64)) throw fail('request_invalid', 'Reload the pricing settings before saving: the save needs the revision you edited (null while the defaults are in use).');
  if (input.confirmCustomerUse !== undefined && typeof input.confirmCustomerUse !== 'boolean') throw fail('request_invalid', 'Customer-use confirmation must be true or false.');
  const receiptId = input.requestId.toLowerCase(), fingerprint = await sha256(canonical({ actor, input }));
  const replay = async () => {
    if (!await priorReceipt(store, receiptId, fingerprint, actor, input.action)) return null;
    const current = await store.read(PRICING_SETTINGS, CURRENT);
    if (current?.requestId !== input.requestId) throw fail('changed_since_operation', 'These pricing settings were saved and have changed since. Reload to see the latest settings.', 409);
    return settingsResult(current, input.requestId, true);
  };
  const replayed = await replay();
  if (replayed) return replayed;
  const settings = validatePricingSettings(input.settings), label = settings.settingsVersion;
  // The label is also the id of its pricingSettingsVersions record, which cannot be '.' or '..'.
  if (!/[A-Za-z0-9]/.test(label)) throw fail('settings_invalid', 'Pricing settings are invalid at settings.settingsVersion: must contain a letter or digit', 400, { path: 'settings.settingsVersion', reason: 'must contain a letter or digit' });
  const row = await store.read(PRICING_SETTINGS, CURRENT), revision = row ? row.revision : null;
  if (input.expectedRevision !== revision) throw fail('revision_conflict', 'The pricing settings changed since you opened them. Reload and review the latest settings.', 409, { currentRevision: revision });
  // The settings being replaced; null when the stored document is unreadable (the owner is repairing it).
  let previous = null;
  try { previous = row ? validatePricingSettings(row.settings) : seedPricingSettings(); } catch { previous = null; }
  if (settings.mustSetBeforeCustomerUse === false && previous?.mustSetBeforeCustomerUse !== false && input.confirmCustomerUse !== true) throw fail('customer_use_unconfirmed', 'Releasing these prices for customer quotes needs explicit confirmation. Review every value, then confirm customer use.');
  if (previous && previous.settingsVersion === label) throw fail('settings_version_unchanged', 'Give the new settings a new version label so every quote records which settings priced it.');
  // A label names one set of values for good: the placeholder label and every label saved before are spent.
  if (label === seedPricingSettings().settingsVersion || await store.read(PRICING_SETTINGS_VERSIONS, label)) throw fail('settings_version_used', `The version label ${label} already named other pricing settings. Give these settings a new label so every quote's settingsVersion names exactly one set of values.`, 409, { settingsVersion: label });
  const readyForCustomers = settings.mustSetBeforeCustomerUse === false;
  const patch = { settings, settingsVersion: label, readyForCustomers, updatedAt: now, updatedBy: actor, requestId: input.requestId };
  const writes = [
    { collection: PRICING_SETTINGS, id: CURRENT, revision, patch },
    { collection: PRICING_SETTINGS_VERSIONS, id: label, patch: { settingsVersion: label, settings, readyForCustomers, savedAt: now, savedBy: actor, requestId: input.requestId } },
    { collection: CATALOG_OPERATIONS, id: receiptId, patch: { action: input.action, fingerprint, actorId: actor, requestId: input.requestId, at: now, result: { settingsVersion: label, readyForCustomers } } },
    auditWrite({ actor: { id: actor, kind: 'human', role: session.role }, via: 'hub', action: 'pricing_settings.update', entity: { collection: PRICING_SETTINGS, id: CURRENT }, before: row ? row.settings ?? null : previous, after: settings, requestId: input.requestId, visibility: 'owner', now }),
  ];
  const { recovered, committed } = await commitOrRecover(store, writes, replay);
  if (recovered) return recovered;
  // The commit applied, so its write result is this save's revision even if another tab has saved since.
  const updateTime = committed?.writeResults?.[0]?.updateTime;
  if (typeof updateTime === 'string' && updateTime) return settingsResult({ ...patch, revision: updateTime }, input.requestId, false);
  const saved = await store.read(PRICING_SETTINGS, CURRENT);
  return saved?.requestId === input.requestId ? settingsResult(saved, input.requestId, false) : settingsResult({ ...patch, revision: null }, input.requestId, false, false);
}

function publishResult(result, requestId, replayed, pointer) {
  if (!plain(result) || typeof result.version !== 'string') throw storageInvalid('catalog receipt');
  const current = pointer?.version === result.version;
  return { ok: true, authority: 'employee_hub', action: 'catalog.publish', requestId, replayed, publication: { source: 'firestore', version: result.version, basedOnVersion: text(result.basedOnVersion), sha256: text(result.sha256), itemCount: result.itemCount, publishedAt: text(result.publishedAt), publishedBy: text(result.publishedBy), revision: current ? pointer.revision : null, current } };
}

async function publish(store, session, input, now, actor) {
  keys(input, ['action', 'requestId', 'basedOnVersion', 'catalog']);
  // null publishes over a pointer whose version is unreadable (GET answers details.currentVersion null).
  if (input.basedOnVersion !== null && (typeof input.basedOnVersion !== 'string' || !VERSION.test(input.basedOnVersion))) throw fail('request_invalid', 'Reload the catalog before publishing: the publish needs the version you edited.');
  // The compact JSON is what the snapshot stores; its one digest is the pointer's sha256 and part of the fingerprint.
  const catalogJson = JSON.stringify(input.catalog) ?? 'null', bytes = encoder.encode(catalogJson);
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw fail('too_large', 'The catalog is too large to publish as one version. Remove retired items or long notes and try again.', 413);
  const catalogSha256 = await digestHex(bytes), receiptId = input.requestId.toLowerCase();
  const fingerprint = await sha256(canonical({ actor, action: input.action, requestId: input.requestId, basedOnVersion: input.basedOnVersion, catalogSha256 }));
  const replay = async () => {
    const receipt = await priorReceipt(store, receiptId, fingerprint, actor, input.action);
    return receipt && publishResult(receipt.result, input.requestId, true, await store.read(CATALOG_VERSIONS, CURRENT));
  };
  const replayed = await replay();
  if (replayed) return replayed;
  const catalog = validateCatalog(input.catalog), version = catalog.catalogVersion;
  if (catalog.generatedOn > denverToday(new Date(now))) throw fail('version_future', `The catalog is dated ${catalog.generatedOn}, after today in Denver. Date it today or earlier.`);
  const pointer = await store.read(CATALOG_VERSIONS, CURRENT), unreadable = Boolean(pointer) && (typeof pointer.version !== 'string' || !VERSION.test(pointer.version));
  const currentVersion = !pointer ? seedCatalog().catalogVersion : unreadable ? null : pointer.version;
  if (input.basedOnVersion !== currentVersion) throw fail('version_conflict', unreadable ? 'The published catalog record is unreadable. Reload the catalog and publish a new version to replace it.' : 'Another catalog version was published since you started editing. Reload the catalog and reapply your changes.', 409, { currentVersion });
  // Replacing an unreadable pointer leaves no current version to be later than, so the seed's is the floor.
  const floor = currentVersion ?? seedCatalog().catalogVersion;
  if (compareVersions(version, floor) <= 0) throw fail('version_not_newer', `The new catalog version must be later than ${floor}.`, 400, { currentVersion });
  if (await store.read(CATALOG_VERSIONS, version)) throw fail('version_exists', `Catalog version ${version} already exists and cannot be replaced. Publish the change as a new version.`, 409);
  const record = { version, basedOnVersion: currentVersion, sha256: catalogSha256, itemCount: catalog.items.length, publishedAt: now, publishedBy: actor };
  const writes = [
    { collection: CATALOG_VERSIONS, id: CURRENT, revision: pointer ? pointer.revision : null, patch: { ...record, requestId: input.requestId } },
    { collection: CATALOG_VERSIONS, id: version, patch: { catalogVersion: version, basedOnVersion: currentVersion, catalogJson, sha256: catalogSha256, itemCount: record.itemCount, generatedOn: catalog.generatedOn, schemaVersion: catalog.schemaVersion, publishedAt: now, publishedBy: actor, requestId: input.requestId } },
    { collection: CATALOG_OPERATIONS, id: receiptId, patch: { action: input.action, fingerprint, actorId: actor, requestId: input.requestId, at: now, result: record } },
    auditWrite({ actor: { id: actor, kind: 'human', role: session.role }, via: 'hub', action: 'catalog.publish', entity: { collection: CATALOG_VERSIONS, id: version }, before: unreadable ? { version: null, source: 'firestore', pointer: 'unreadable' } : { version: currentVersion, source: pointer ? 'firestore' : 'seed' }, after: { version, generatedOn: catalog.generatedOn, itemCount: record.itemCount, sha256: catalogSha256 }, requestId: input.requestId, now }),
  ];
  const { recovered, committed } = await commitOrRecover(store, writes, replay);
  if (recovered) return recovered;
  // The commit applied: its write result is the pointer's new revision. Without one, the pointer read supplies
  // it (or current:false after a newer publish).
  const updateTime = committed?.writeResults?.[0]?.updateTime;
  return publishResult(record, input.requestId, false, typeof updateTime === 'string' && updateTime ? { version, revision: updateTime } : await store.read(CATALOG_VERSIONS, CURRENT));
}

/** Owner-only writes. settings.update {requestId, expectedRevision, settings, confirmCustomerUse?} replaces the
 * pricing settings; turning mustSetBeforeCustomerUse off needs confirmCustomerUse:true, and settingsVersion must be
 * a label never saved before (nor the placeholder's). catalog.publish {requestId, basedOnVersion, catalog} publishes
 * a new immutable, later version over exactly basedOnVersion (null only to replace an unreadable pointer). A replay
 * of the same requestId and body returns the saved result (replayed:true). */
export async function mutateCatalog(store, session, input, now = new Date().toISOString()) {
  requireCatalogOwner(session);
  if (typeof now !== 'string' || !INSTANT.test(now) || !Number.isFinite(Date.parse(now))) throw fail('clock_invalid', 'The server clock is unavailable. Retry.', 503);
  if (!plain(input)) throw fail('request_invalid', 'The catalog request was incomplete. Reload and try again.');
  if (!CATALOG_ACTIONS.includes(input.action)) throw fail('action_invalid', 'Choose settings.update or catalog.publish.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Each catalog change needs a request ID. Reload and try again.');
  const actor = String(session.user).trim().toLowerCase();
  return input.action === 'settings.update' ? updateSettings(store, session, input, now, actor) : publish(store, session, input, now, actor);
}
