/** The owner's business baselines and targets: the job-costing labor baseline, the lead wage, truck rental per job and
 * the sales targets the Hub Playbook and Scorecard show. Owner-entered, never in code (the repo is public). Server-only
 * collections, stored like the job-actuals cost settings (functions/_lib/job-actuals-settings.js):
 *   ownerEconomicsSettings/current               {schemaVersion:1, laborCostCentsPerCrewHour, leadWageCentsPerHour,
 *                                                 truckRentalLowCentsPerJob, truckRentalHighCentsPerJob,
 *                                                 averageTicketTargetCents, walkthroughSetRateTargetBp,
 *                                                 qualifiedCloseRateTargetBp, updatedAt, updatedBy, requestId}
 *   ownerEconomicsSettingsOperations/<requestId> receipts {action, requestId, fingerprint, actorId, at, changed}
 * Each setting is a whole number (cents or basis points) or null while the owner has not entered it: blank is unknown,
 * never $0, and the screens fall back to their generic text. The crew wage is not stored here: it is the Job actuals crew
 * wage (jobActualsSettings/current wageCentsPerManHour), so there is one number. Unlike the job-actuals settings, which
 * business users read, only the owner reads or writes these; a write commits its receipt and an owner-visibility
 * hub_audit entry in the same Firestore commit, under the stored revision (Firestore updateTime). */
import { isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { standardCostStorage } from './standard-costs.js';
import { jobActualsSettingsStorage, readJobActualsSettings } from './job-actuals-settings.js';

export const OWNER_ECONOMICS_SETTINGS = 'ownerEconomicsSettings', OWNER_ECONOMICS_SETTINGS_OPERATIONS = 'ownerEconomicsSettingsOperations', CURRENT = 'current';
export const OWNER_ECONOMICS_ACTION = 'owner_economics.settings.set';
export const OWNER_ECONOMICS_KEYS = Object.freeze(['laborCostCentsPerCrewHour', 'leadWageCentsPerHour', 'truckRentalLowCentsPerJob', 'truckRentalHighCentsPerJob', 'averageTicketTargetCents', 'walkthroughSetRateTargetBp', 'qualifiedCloseRateTargetBp']);
// Ceilings: $200 an hour, $5,000 a job, a $100,000 ticket, 100%.
export const OWNER_ECONOMICS_LIMITS = Object.freeze({ laborCostCentsPerCrewHour: 20000, leadWageCentsPerHour: 20000, truckRentalLowCentsPerJob: 500000, truckRentalHighCentsPerJob: 500000, averageTicketTargetCents: 10000000, walkthroughSetRateTargetBp: 10000, qualifiedCloseRateTargetBp: 10000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `owner_economics_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const validOwnerEconomicsSetting = (key, value) => value === null || Number.isSafeInteger(value) && value >= 0 && value <= OWNER_ECONOMICS_LIMITS[key];
const rangeInverted = settings => settings.truckRentalLowCentsPerJob !== null && settings.truckRentalHighCentsPerJob !== null && settings.truckRentalLowCentsPerJob > settings.truckRentalHighCentsPerJob;

export function requireOwnerEconomicsOwner(session) {
  if (!session?.user) throw fail('sign_in_required', 'Sign in to review owner targets.', 401);
  if (!isHubOwner(session)) throw fail('owner_required', 'Only the owner can view or change owner targets and baselines.', 403);
}

/** The standard-cost Firestore storage, with its errors renamed owner_economics_* (revision_conflict, outcome_unknown, ...). */
export function ownerEconomicsStorage(env, base = standardCostStorage(env)) {
  const MESSAGES = {
    unavailable: 'Owner targets could not be loaded. Retry.',
    storage_incomplete: 'Owner-targets storage returned a record that could not be verified. Retry.',
    revision_conflict: 'Owner targets changed while you were editing. Load the latest and save again.',
    outcome_unknown: 'The owner-targets save could not be confirmed. Retry the same save to check whether it was applied; it will not be applied twice.',
    storage_rejected: 'Owner-targets storage refused this change. Nothing was saved.' };
  const rename = error => {
    if (/^standard_cost_/.test(error?.code || '')) { const key = error.code.replace(/^standard_cost_/, ''); error.code = `owner_economics_${key}`; if (MESSAGES[key]) error.message = MESSAGES[key]; }
    return error;
  };
  return {
    async read(collection, id) { try { return await base.read(collection, id); } catch (error) { throw rename(error); } },
    async commit(writes) { try { return await base.commit(writes); } catch (error) { throw rename(error); } },
  };
}

// A stored record that fails verification fails closed: no figure is guessed.
function storedSettings(row) {
  const blank = Object.fromEntries(OWNER_ECONOMICS_KEYS.map(key => [key, null]));
  if (!row) return { revision: null, updatedAt: null, updatedBy: null, ...blank };
  const settings = Object.fromEntries(OWNER_ECONOMICS_KEYS.map(key => [key, row[key] ?? null]));
  if (row.schemaVersion !== 1 || OWNER_ECONOMICS_KEYS.some(key => !validOwnerEconomicsSetting(key, settings[key])) || rangeInverted(settings)) throw fail('settings_invalid', 'The saved owner targets failed verification. Save them again.', 503);
  return { revision: row.revision, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null, updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null, ...settings };
}

export async function readOwnerEconomicsSettings(store) {
  return storedSettings(await store.read(OWNER_ECONOMICS_SETTINGS, CURRENT));
}

/** What the Hub's owner screens read (the pricing-config `owner` part): dollars and whole percents, each null while blank.
 * The crew wage is the Job actuals crew wage. */
export function ownerEconomics(settings = {}, crewWageCentsPerManHour = null) {
  const dollars = cents => Number.isSafeInteger(cents) ? cents / 100 : null, percent = bp => Number.isSafeInteger(bp) ? bp / 100 : null;
  return {
    laborCostPerCrewHour: dollars(settings.laborCostCentsPerCrewHour),
    wages: { crew: dollars(crewWageCentsPerManHour), lead: dollars(settings.leadWageCentsPerHour) },
    truckRentalPerJob: { low: dollars(settings.truckRentalLowCentsPerJob), high: dollars(settings.truckRentalHighCentsPerJob) },
    targets: { averageTicket: dollars(settings.averageTicketTargetCents), walkthroughSetRatePct: percent(settings.walkthroughSetRateTargetBp), qualifiedCloseRatePct: percent(settings.qualifiedCloseRateTargetBp) },
  };
}

/** The owner part for /api/pricing-config, read from both settings docs. Any read failure throws: never a guessed number. */
export async function readOwnerEconomics(env, { store = ownerEconomicsStorage(env), jobActuals = jobActualsSettingsStorage(env) } = {}) {
  const [settings, costs] = await Promise.all([readOwnerEconomicsSettings(store), readJobActualsSettings(jobActuals)]);
  return ownerEconomics(settings, costs.wageCentsPerManHour);
}

/** POST {action:'owner_economics.settings.set', requestId, expectedRevision, settings:{<every key>: integer|null}} (owner).
 * The same requestId replays the saved settings; with a different body it is a 409. */
export async function mutateOwnerEconomicsSettings(store, session, input, now = new Date().toISOString()) {
  requireOwnerEconomicsOwner(session);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'settings'].includes(key))) throw fail('request_invalid', 'The owner-targets request contains unsupported fields. Reload and try again.');
  if (input.action !== OWNER_ECONOMICS_ACTION) throw fail('request_invalid', 'Choose a supported owner-targets action.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'A unique request ID is required. Reload and try again.');
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80)) throw fail('request_invalid', 'The current owner-targets version is required. Reload and try again.');
  if (!plain(input.settings) || Object.keys(input.settings).length !== OWNER_ECONOMICS_KEYS.length || OWNER_ECONOMICS_KEYS.some(key => !Object.hasOwn(input.settings, key))) throw fail('request_invalid', 'Send every owner target, blank ones as null.');
  for (const key of OWNER_ECONOMICS_KEYS) if (!validOwnerEconomicsSetting(key, input.settings[key])) throw fail('amount_invalid', `Enter ${key} as a whole number from 0 to ${OWNER_ECONOMICS_LIMITS[key]}, or leave it blank.`, 400, { key });
  if (rangeInverted(input.settings)) throw fail('amount_invalid', 'The low truck rental cannot be above the high one.', 400, { key: 'truckRentalLowCentsPerJob' });
  const requestId = input.requestId.toLowerCase(), fingerprint = await digest(canonical({ actor: String(session.user).toLowerCase(), input: { ...input, requestId } }));
  const receipt = await store.read(OWNER_ECONOMICS_SETTINGS_OPERATIONS, requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different save. Reload before saving again.', 409);
    return { settings: await readOwnerEconomicsSettings(store), requestId, replayed: true };
  }
  const current = storedSettings(await store.read(OWNER_ECONOMICS_SETTINGS, CURRENT));
  if (current.revision !== input.expectedRevision) throw fail('revision_conflict', 'Owner targets changed while you were editing. Load the latest and save again.', 409);
  const before = {}, after = {};
  for (const key of OWNER_ECONOMICS_KEYS) if (current[key] !== input.settings[key]) { before[key] = current[key]; after[key] = input.settings[key]; }
  const changed = Object.keys(after);
  if (!changed.length) throw fail('no_change', 'These owner targets are already saved.');
  const patch = { schemaVersion: 1, ...Object.fromEntries(OWNER_ECONOMICS_KEYS.map(key => [key, input.settings[key]])), updatedAt: now, updatedBy: session.user, requestId };
  const audit = auditWrite({ actor: { id: session.user, kind: 'human', role: session.role }, via: 'hub', action: OWNER_ECONOMICS_ACTION, entity: { collection: OWNER_ECONOMICS_SETTINGS, id: CURRENT }, before, after, requestId, visibility: 'owner', now });
  await store.commit([
    { collection: OWNER_ECONOMICS_SETTINGS, id: CURRENT, revision: current.revision, patch },
    { collection: OWNER_ECONOMICS_SETTINGS_OPERATIONS, id: requestId, patch: { action: OWNER_ECONOMICS_ACTION, requestId, fingerprint, actorId: session.user, at: now, changed } },
    { collection: audit.collection, id: audit.id, patch: audit.patch },
  ]);
  return { settings: await readOwnerEconomicsSettings(store), requestId, replayed: false };
}
