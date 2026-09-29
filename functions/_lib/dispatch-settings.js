import { can } from './staff-roles.js';
import { auditWrite } from './hub-audit.js';
import { SKILL_CATALOG } from './staff-skills.js';

/** Owner dispatch settings (P1-DS-06): one server-only document
 * dispatchSettings/current, read by every dispatch check and written only
 * through /api/dispatch-settings (owner, settings.manage). A missing document,
 * or a malformed field in it, reads as the default below, and the defaults are
 * exactly today's behaviour: every rule is a warning, no daily limits, a 20
 * minute travel buffer on new jobs, openings searched 08:00-17:00 and the
 * arrival window length from EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES (60).
 * block* turns that rule's warning into a 409 dispatch_conflict on save
 * (dispatch-rules.js); blockTravelShort adds to EGC_DISPATCH_BLOCK_TRAVEL_SHORT
 * and, like it, needs drive estimates (EGC_DISPATCH_TRAVEL_ESTIMATES). A save
 * also advances dispatchState/revision, so a schedule check that read the old
 * settings cannot commit after them. No backfill: no job field is derived. */
export const DISPATCH_SETTINGS_COLLECTION = 'dispatchSettings', DISPATCH_SETTINGS_ID = 'current';
export const DISPATCH_SETTINGS_DEFAULTS = Object.freeze({
  defaultTravelBufferMinutes: 20, defaultArrivalWindowMinutes: null, workdayStart: '08:00', workdayEnd: '17:00',
  blockCrewShort: false, blockSkillMissing: false, blockTravelShort: false, blockOverCapacity: false, blockOutsideHours: false,
  maxJobsPerEmployeePerDay: null, maxHoursPerEmployeePerDay: null,
});
const KEYS = Object.keys(DISPATCH_SETTINGS_DEFAULTS);
const BLOCKS = KEYS.filter(key => key.startsWith('block'));
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : isObject(value) ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2,'0')).join('');
const minute = value => value === '24:00' ? 1440 : Number(value.slice(0,2)) * 60 + Number(value.slice(3));

// One checker per field: the value when valid, otherwise undefined.
const CHECK = {
  defaultTravelBufferMinutes: value => Number.isInteger(value) && value >= 0 && value <= 180 ? value : undefined,
  defaultArrivalWindowMinutes: value => value === null || Number.isInteger(value) && value >= 15 && value <= 480 ? value : undefined,
  workdayStart: value => typeof value === 'string' && HHMM.test(value) ? value : undefined,
  workdayEnd: value => typeof value === 'string' && (HHMM.test(value) || value === '24:00') ? value : undefined,
  maxJobsPerEmployeePerDay: value => value === null || Number.isInteger(value) && value >= 1 && value <= 20 ? value : undefined,
  maxHoursPerEmployeePerDay: value => value === null || typeof value === 'number' && Number.isInteger(value * 4) && value >= 1 && value <= 24 ? value : undefined,
  ...Object.fromEntries(BLOCKS.map(key => [key, value => typeof value === 'boolean' ? value : undefined])),
};
const MESSAGES = {
  defaultTravelBufferMinutes: 'The default travel buffer must be a whole number of minutes from 0 to 180.',
  defaultArrivalWindowMinutes: 'The default arrival window must be 15 to 480 whole minutes, or empty to keep the Hub default.',
  workdayStart: 'The workday start must use HH:MM.',
  workdayEnd: 'The workday end must use HH:MM, or 24:00 for midnight.',
  maxJobsPerEmployeePerDay: 'Jobs per employee per day must be a whole number from 1 to 20, or empty for no limit.',
  maxHoursPerEmployeePerDay: 'Hours per employee per day must be 1 to 24 in quarter hours, or empty for no limit.',
};

/** Stored settings as every reader sees them. Invalid fields read as their
 * default and are named in invalidFields; the document is never repaired
 * silently. A workday that does not end after it starts reads as the default. */
export function normalizeDispatchSettings(row) {
  const stored = isObject(row) ? row : {}, invalidFields = [], values = {};
  for (const key of KEYS) {
    const value = stored[key] === undefined ? undefined : CHECK[key](stored[key]);
    if (stored[key] !== undefined && value === undefined) invalidFields.push(key);
    values[key] = value === undefined ? DISPATCH_SETTINGS_DEFAULTS[key] : value;
  }
  if (minute(values.workdayEnd) <= minute(values.workdayStart)) {
    for (const key of ['workdayStart','workdayEnd']) if (!invalidFields.includes(key)) invalidFields.push(key);
    Object.assign(values, { workdayStart: DISPATCH_SETTINGS_DEFAULTS.workdayStart, workdayEnd: DISPATCH_SETTINGS_DEFAULTS.workdayEnd });
  }
  return { values: Object.freeze(values), invalidFields, source: row ? 'firestore' : 'defaults', revision: row?.revision || null,
    updatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null, updatedBy: typeof row?.updatedBy === 'string' ? row.updatedBy : null };
}

/** The settings for one dispatch request. Stores without read() (older test
 * doubles) use the defaults; a failed read fails the request (no guessing). */
export async function dispatchRuleSettings(store) {
  if (typeof store?.read !== 'function') return DISPATCH_SETTINGS_DEFAULTS;
  return normalizeDispatchSettings(await store.read(DISPATCH_SETTINGS_COLLECTION, DISPATCH_SETTINGS_ID)).values;
}

/** Arrival settings with the owner's window length over the env default. */
export function effectiveArrivalSettings(envSettings, values) {
  const minutes = values?.defaultArrivalWindowMinutes;
  return Number.isInteger(minutes) ? { ...envSettings, defaultArrivalWindowMinutes: minutes } : { ...envSettings };
}

/** Non-secret rule summary for dispatch screens: skill labels for the job
 * editor, openings defaults and which rules block a save. */
export function dispatchRulesView(values) {
  const settings = values || DISPATCH_SETTINGS_DEFAULTS;
  return { skills: SKILL_CATALOG.map(({ id, label }) => ({ id, label })), workdayStart: settings.workdayStart, workdayEnd: settings.workdayEnd,
    defaultTravelBufferMinutes: settings.defaultTravelBufferMinutes, maxJobsPerEmployeePerDay: settings.maxJobsPerEmployeePerDay, maxHoursPerEmployeePerDay: settings.maxHoursPerEmployeePerDay,
    blocking: { crewShort: settings.blockCrewShort, skillMissing: settings.blockSkillMissing, travelShort: settings.blockTravelShort, overCapacity: settings.blockOverCapacity, outsideHours: settings.blockOutsideHours } };
}

export function requireSettingsOwner(session, env) {
  if (!session) throw fail('dispatch_sign_in_required', 'Sign in to the Employee Hub to change dispatch settings.', 401);
  if (!can(session, 'settings.manage', env)) throw fail('dispatch_settings_forbidden', 'Only the owner can view or change dispatch settings.', 403);
}

function settingsBody(row, extra = {}) {
  const state = normalizeDispatchSettings(row);
  return { ok: true, authority: 'employee_hub', ...extra,
    settings: { revision: state.revision, source: state.source, values: state.values, invalidFields: state.invalidFields, updatedAt: state.updatedAt, updatedBy: state.updatedBy },
    defaults: DISPATCH_SETTINGS_DEFAULTS, skills: SKILL_CATALOG.map(({ id, label }) => ({ id, label })) };
}

/** GET /api/dispatch-settings (owner). */
export async function dispatchSettingsOverview(store, session, env = {}) {
  requireSettingsOwner(session, env);
  return { ...settingsBody(await store.read(DISPATCH_SETTINGS_COLLECTION, DISPATCH_SETTINGS_ID)), viewer: { id: session.user } };
}

function nextValues(changes, current) {
  if (!isObject(changes) || !Object.keys(changes).length) throw fail('dispatch_settings_invalid', 'Choose at least one dispatch setting to change.');
  const unknown = Object.keys(changes).filter(key => !KEYS.includes(key));
  if (unknown.length) throw fail('dispatch_settings_invalid', 'This request contains unsupported dispatch settings. Reload the settings and try again.', 400, { fields: unknown });
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    const checked = CHECK[key](value);
    if (checked === undefined) throw fail('dispatch_settings_invalid', MESSAGES[key] || `${key} must be true or false.`, 400, { field: key });
    next[key] = checked;
  }
  if (minute(next.workdayEnd) <= minute(next.workdayStart)) throw fail('dispatch_settings_invalid', 'The workday must end after it starts on the same day. Use 24:00 for midnight.', 400, { field: 'workdayEnd' });
  return next;
}

/** POST {action:'settings.update',requestId,expectedRevision:string|null,
 * changes:{...some settings},reason?} (owner). expectedRevision is
 * settings.revision from GET (null while the defaults are in use). The receipt
 * (dispatchOperations/<requestId>, scope 'dispatch_settings'), the settings,
 * dispatchState/revision and a hub_audit entry commit together. */
export async function mutateDispatchSettings(store, session, input, now = new Date().toISOString(), env = {}) {
  requireSettingsOwner(session, env);
  if (!isObject(input) || input.action !== 'settings.update' || !UUID.test(input.requestId || '')) throw fail('dispatch_request_invalid', 'Use settings.update with a unique request ID.');
  if (Object.keys(input).some(key => !['action','requestId','expectedRevision','changes','reason'].includes(key))) throw fail('dispatch_patch_not_allowed', 'This request contains unsupported fields. Reload the settings and try again.');
  if (!Object.hasOwn(input, 'expectedRevision') || input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 64)) throw fail('dispatch_settings_invalid', 'Reload the dispatch settings before saving: the save needs the revision you edited (null while the defaults are in use).');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) throw fail('dispatch_settings_invalid', 'The reason must be text of at most 500 characters.');
  const fingerprint = await digest({ actor: session.user, input }), receiptId = input.requestId.toLowerCase();
  const replay = async () => {
    const receipt = await store.read('dispatchOperations', receiptId);
    if (!receipt) return null;
    if (receipt.scope !== 'dispatch_settings' || receipt.fingerprint !== fingerprint) throw fail('dispatch_idempotency_conflict', 'This request ID was already used for a different change. Reload the settings before saving.', 409);
    const saved = await store.read(DISPATCH_SETTINGS_COLLECTION, DISPATCH_SETTINGS_ID);
    if (!saved) throw fail('dispatch_saved_record_missing', 'The saved dispatch settings are no longer available. Reload and review.', 409);
    if (saved.settingsRequestId !== input.requestId) throw fail('dispatch_changed_since_operation', 'That change saved, but the dispatch settings have changed since. Reload to see the latest settings.', 409);
    return settingsBody(saved, { requestId: input.requestId, replayed: true });
  };
  try {
    const previous = await replay();
    if (previous) return previous;
    for (let attempt = 0; ; attempt++) {
      // Same guard as schedule writes: a check that read the old rules cannot commit after this save.
      const guard = await store.read('dispatchState', 'revision');
      const row = await store.read(DISPATCH_SETTINGS_COLLECTION, DISPATCH_SETTINGS_ID), revision = row?.revision || null;
      if (input.expectedRevision !== revision) throw fail('dispatch_settings_revision_conflict', 'The dispatch settings changed since you opened them. Reload and review the latest settings.', 409, { currentRevision: revision });
      const before = normalizeDispatchSettings(row).values, after = nextValues(input.changes, before);
      const patch = { ...after, updatedAt: now, updatedBy: session.user, settingsRequestId: input.requestId };
      const writes = [
        { collection: DISPATCH_SETTINGS_COLLECTION, id: DISPATCH_SETTINGS_ID, revision: row?.revision, patch },
        { collection: 'dispatchState', id: 'revision', revision: guard?.revision, patch: { updatedAt: now, lastRequestId: input.requestId } },
        { collection: 'dispatchOperations', id: receiptId, patch: { scope: 'dispatch_settings', fingerprint, actorId: session.user, action: input.action, collection: DISPATCH_SETTINGS_COLLECTION, targetId: DISPATCH_SETTINGS_ID, requestId: input.requestId, createdAt: now, before: row ? before : null, after, warnings: [] } },
        auditWrite({ actor: { id: session.user, kind: 'human', role: session.role }, via: 'hub', action: 'dispatch_settings.update', entity: { collection: DISPATCH_SETTINGS_COLLECTION, id: DISPATCH_SETTINGS_ID }, before: row ? before : null, after, requestId: input.requestId, reason: input.reason?.trim() || null, now }),
      ];
      try { await store.commit(writes); break; }
      catch (error) {
        const receipt = await store.read('dispatchOperations', receiptId).catch(() => null);
        if (receipt?.fingerprint === fingerprint) break;
        // A schedule save that moved dispatchState/revision is not a settings
        // conflict: the loop re-reads both and retries once (a settings change
        // since then is the real 409 above), then asks for a retry, not a reload.
        if (receipt || error?.code !== 'dispatch_revision_conflict') throw error;
        if (attempt) throw fail('dispatch_settings_busy', 'The schedule was being saved at the same moment, so the dispatch settings were not saved. Your changes are kept; retry the same save.', 503);
      }
    }
    const saved = await store.read(DISPATCH_SETTINGS_COLLECTION, DISPATCH_SETTINGS_ID);
    if (!saved) throw fail('dispatch_outcome_unknown', 'The saved settings could not be verified. Retry the same request.', 503);
    if (saved.settingsRequestId !== input.requestId) throw fail('dispatch_changed_since_operation', 'The save succeeded, but the dispatch settings changed again. Reload to review the latest settings.', 409);
    return settingsBody(saved, { requestId: input.requestId, replayed: false });
  } catch (error) {
    // Another copy of this request may have committed after our first receipt read.
    if (['dispatch_changed_since_operation','dispatch_idempotency_conflict','dispatch_settings_forbidden'].includes(error?.code)) throw error;
    const recovered = await replay().catch(() => null);
    if (recovered) return recovered;
    throw error;
  }
}
