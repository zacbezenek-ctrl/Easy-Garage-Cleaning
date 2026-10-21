/** The owner's job-actuals cost settings (functions/_lib/job-actuals.js). Server-only collections:
 *   jobActualsSettings/current               {schemaVersion:1, payrollTaxBp, burdenCentsPerManHour, dumpFeeCentsPerLoad,
 *                                             truckCentsPerJob, goodsTaxBp, updatedAt, updatedBy, requestId}
 *   jobActualsSettingsOperations/<requestId> receipts {action, requestId, fingerprint, actorId, at, changed}
 * Each setting is a whole number (basis points or cents) or null while the owner has not entered it: blank is unknown,
 * never $0 entered. Business users read; only the owner writes, and a write commits its receipt and an owner-visibility
 * hub_audit entry in the same Firestore commit, under the stored revision (Firestore updateTime), as standard costs do. */
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { standardCostStorage } from './standard-costs.js';
import { COST_SETTING_KEYS, COST_SETTING_LIMITS, normalizeCostSettings, validCostSetting } from './job-actuals.js';

export const JOB_ACTUALS_SETTINGS = 'jobActualsSettings', JOB_ACTUALS_SETTINGS_OPERATIONS = 'jobActualsSettingsOperations', CURRENT = 'current';
export const JOB_ACTUALS_SETTINGS_ACTION = 'job_actuals.settings.set';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `job_actuals_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function requireJobActualsViewer(session) {
  if (!session?.user) throw fail('sign_in_required', 'Sign in to review job actuals.', 401);
  if (!hasBusinessAccess(session)) throw fail('forbidden', 'Only business accounts can review job actuals.', 403);
}
export function requireJobActualsOwner(session) {
  requireJobActualsViewer(session);
  if (!isHubOwner(session)) throw fail('owner_required', 'Only the owner can change job cost settings.', 403);
}

/** The standard-cost Firestore storage, with its errors renamed job_actuals_* (revision_conflict, outcome_unknown, ...). */
export function jobActualsSettingsStorage(env, base = standardCostStorage(env)) {
  // Same codes as standard costs under job_actuals_*, with this screen's own wording.
  const MESSAGES = {
    unavailable: 'Job cost settings could not be loaded. Retry.',
    storage_incomplete: 'Job cost settings storage returned a record that could not be verified. Retry.',
    revision_conflict: 'Cost settings changed while you were editing. Load the latest settings and save again.',
    outcome_unknown: 'The cost-settings save could not be confirmed. Retry the same save to check whether it was applied; it will not be applied twice.',
    storage_rejected: 'Cost-settings storage refused this change. Nothing was saved.' };
  const rename = error => {
    if (/^standard_cost_/.test(error?.code || '')) { const key = error.code.replace(/^standard_cost_/, ''); error.code = `job_actuals_${key}`; if (MESSAGES[key]) error.message = MESSAGES[key]; }
    return error;
  };
  return {
    async read(collection, id) { try { return await base.read(collection, id); } catch (error) { throw rename(error); } },
    async commit(writes) { try { return await base.commit(writes); } catch (error) { throw rename(error); } },
  };
}

// A stored record that fails verification fails closed: no cost is guessed.
function storedSettings(row) {
  if (!row) return { revision: null, updatedAt: null, updatedBy: null, ...normalizeCostSettings({}) };
  if (row.schemaVersion !== 1 || COST_SETTING_KEYS.some(key => !validCostSetting(key, row[key] ?? null))) throw fail('settings_invalid', 'The saved job cost settings failed verification. The owner must save them again.', 503);
  return { revision: row.revision, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null, updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null, ...normalizeCostSettings(row) };
}

export async function readJobActualsSettings(store) {
  return storedSettings(await store.read(JOB_ACTUALS_SETTINGS, CURRENT));
}

/** POST {action:'job_actuals.settings.set', requestId, expectedRevision, settings:{<every key>: integer|null}} (owner).
 * The same requestId replays the saved settings; with a different body it is a 409. */
export async function mutateJobActualsSettings(store, session, input, now = new Date().toISOString()) {
  requireJobActualsOwner(session);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'settings'].includes(key))) throw fail('request_invalid', 'The cost-settings request contains unsupported fields. Reload and try again.');
  if (input.action !== JOB_ACTUALS_SETTINGS_ACTION) throw fail('request_invalid', 'Choose a supported cost-settings action.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'A unique request ID is required. Reload and try again.');
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80)) throw fail('request_invalid', 'The current cost-settings version is required. Reload and try again.');
  if (!plain(input.settings) || Object.keys(input.settings).length !== COST_SETTING_KEYS.length || COST_SETTING_KEYS.some(key => !Object.hasOwn(input.settings, key))) throw fail('request_invalid', 'Send every cost setting, blank ones as null.');
  for (const key of COST_SETTING_KEYS) if (!validCostSetting(key, input.settings[key])) throw fail('amount_invalid', `Enter ${key} as a whole number from 0 to ${COST_SETTING_LIMITS[key]}, or leave it blank.`, 400, { key });
  const requestId = input.requestId.toLowerCase(), fingerprint = await digest(canonical({ actor: String(session.user).toLowerCase(), input: { ...input, requestId } }));
  const receipt = await store.read(JOB_ACTUALS_SETTINGS_OPERATIONS, requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different save. Reload before saving again.', 409);
    return { settings: await readJobActualsSettings(store), requestId, replayed: true };
  }
  const current = storedSettings(await store.read(JOB_ACTUALS_SETTINGS, CURRENT));
  if (current.revision !== input.expectedRevision) throw fail('revision_conflict', 'Cost settings changed while you were editing. Load the latest settings and save again.', 409);
  const before = {}, after = {};
  for (const key of COST_SETTING_KEYS) if (current[key] !== input.settings[key]) { before[key] = current[key]; after[key] = input.settings[key]; }
  const changed = Object.keys(after);
  if (!changed.length) throw fail('no_change', 'These cost settings are already saved.');
  const patch = { schemaVersion: 1, ...Object.fromEntries(COST_SETTING_KEYS.map(key => [key, input.settings[key]])), updatedAt: now, updatedBy: session.user, requestId };
  const audit = auditWrite({ actor: { id: session.user, kind: 'human', role: session.role }, via: 'hub', action: JOB_ACTUALS_SETTINGS_ACTION, entity: { collection: JOB_ACTUALS_SETTINGS, id: CURRENT }, before, after, requestId, visibility: 'owner', now });
  await store.commit([
    { collection: JOB_ACTUALS_SETTINGS, id: CURRENT, revision: current.revision, patch },
    { collection: JOB_ACTUALS_SETTINGS_OPERATIONS, id: requestId, patch: { action: JOB_ACTUALS_SETTINGS_ACTION, requestId, fingerprint, actorId: session.user, at: now, changed } },
    { collection: audit.collection, id: audit.id, patch: audit.patch },
  ]);
  return { settings: await readJobActualsSettings(store), requestId, replayed: false };
}
