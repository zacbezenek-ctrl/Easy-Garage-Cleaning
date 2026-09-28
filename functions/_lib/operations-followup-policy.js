import { firestoreFetch } from './firebase-service-account.js';
import { encodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { addDays } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { hasBusinessAccess } from './hub-session.js';
import { ROLE_CAPABILITIES, can } from './staff-roles.js';
import { operationsStaffMembersEnabled } from './operations-staff.js';
import { auditWrite } from './hub-audit.js';

// P3-04: who owns walkthrough and call follow-ups (the phone/sales person) and when they
// are due. The owner comes from the owner-only Hub settings (operations_settings/followups),
// else EGC_OPERATIONS_FOLLOWUP_OWNER_ID, else the sole member holding
// EGC_OPERATIONS_FOLLOWUP_ROLE; anything else stays unresolved. A configured owner that is
// unknown, inactive or cannot own follow-ups blocks the policy with an explicit reason and
// never falls through to another source; a sales or phone user kept out only by
// EGC_OPERATIONS_STAFF_MEMBERS being off is followup_owner_staff_disabled. Deterministic
// code, not a model, picks owner and due.
export const FOLLOWUP_SETTINGS_COLLECTION = 'operations_settings';
export const FOLLOWUP_SETTINGS_ID = 'followups';
export const FOLLOWUP_TIME_ZONE = 'America/Denver';
export const FOLLOWUP_DUE = Object.freeze({ min: 15, max: 10080, default: 240 });
// Federal quiet hours allow customer calls and texts from 8 AM to 9 PM local time; the
// send window may only narrow them (and so never touches a 2 AM DST change).
export const FOLLOWUP_WINDOW = Object.freeze({ earliest: 8, latest: 21, startHour: 8, endHour: 19 });
const ROLES = ['owner', 'manager', 'sales', 'phone'];
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const INPUT_KEYS = ['requestId', 'expectedRevision', 'ownerId', 'dueMinutes', 'sendWindow', 'reason'];

export const followupPolicyEnabled = env => env?.EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED === 'true';
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'followup_settings_' + code, status, ...(details ? { details } : {}) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => String(value ?? '').trim().toLowerCase();
const envText = value => typeof value === 'string' ? value.trim() : '';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : record(value) ? `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}` : JSON.stringify(value ?? null);
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// The roles under which a member may own follow-ups (the followups.own capability).
export function followupRoles(member) {
  if (!record(member) || member.active === false) return [];
  const roles = [member.role, ...(Array.isArray(member.staffRoles) ? member.staffRoles : [])];
  return [...new Set(roles.filter(role => typeof role === 'string' && Object.hasOwn(ROLE_CAPABILITIES, role) && ROLE_CAPABILITIES[role].includes('followups.own')))];
}

export const validDueMinutes = value => Number.isInteger(value) && value >= FOLLOWUP_DUE.min && value <= FOLLOWUP_DUE.max;
export function validSendWindow(value) {
  if (!record(value) || Object.keys(value).some(name => !['startHour', 'endHour', 'timeZone'].includes(name))) return false;
  const { startHour, endHour, timeZone = FOLLOWUP_TIME_ZONE } = value;
  return timeZone === FOLLOWUP_TIME_ZONE && Number.isInteger(startHour) && Number.isInteger(endHour) && startHour >= FOLLOWUP_WINDOW.earliest && endHour <= FOLLOWUP_WINDOW.latest && startHour < endHour;
}

// settings: the saved document, null when none exists, or undefined when it could not be read.
export function followupPolicy(env, members, settings) {
  const roster = (Array.isArray(members) ? members : []).filter(member => record(member) && typeof member.id === 'string' && member.id.trim());
  const policy = (fields, blockedReason = null) => ({ authority: 'employee_hub', followup: { enabled: false, ownerId: null, ownerRole: null, ownerSource: 'unresolved', dueMinutes: null, dueSource: null, sendWindow: null, blockedReason, ...fields } });
  if (settings === undefined || settings !== null && !record(settings)) return policy({}, 'followup_settings_unavailable');
  const saved = settings || {};
  const ownerId = saved.ownerId === undefined || saved.ownerId === null ? '' : typeof saved.ownerId === 'string' && saved.ownerId.trim() && saved.ownerId.length <= 80 ? saved.ownerId.trim() : null;
  const dueSource = saved.dueMinutes === undefined || saved.dueMinutes === null ? 'default' : 'settings';
  const dueMinutes = dueSource === 'default' ? FOLLOWUP_DUE.default : validDueMinutes(saved.dueMinutes) ? saved.dueMinutes : null;
  const window = saved.sendWindow === undefined || saved.sendWindow === null ? { startHour: FOLLOWUP_WINDOW.startHour, endHour: FOLLOWUP_WINDOW.endHour } : validSendWindow(saved.sendWindow) ? saved.sendWindow : null;
  const sendWindow = window && { startHour: window.startHour, endHour: window.endHour, timeZone: FOLLOWUP_TIME_ZONE };
  if (ownerId === null) return policy({ ownerSource: 'settings', dueMinutes, dueSource, sendWindow }, 'followup_settings_invalid');
  const envOwner = envText(env?.EGC_OPERATIONS_FOLLOWUP_OWNER_ID), envRole = envText(env?.EGC_OPERATIONS_FOLLOWUP_ROLE).toLowerCase();
  let owner = null, ownerRole = null, ownerSource = 'unresolved', reason = null;
  const configured = ownerId || envOwner;
  if (configured) {
    ownerSource = ownerId ? 'settings' : 'env';
    const found = roster.filter(member => key(member.id) === key(configured)), roles = found.length === 1 ? followupRoles(found[0]) : [];
    if (found.length > 1) reason = 'followup_owner_ambiguous';
    else if (!found.length) reason = 'followup_owner_unknown';
    else if (found[0].active === false) reason = 'followup_owner_inactive';
    else if (found[0].staffOnly === true) reason = 'followup_owner_staff_disabled';
    else if (!roles.length) reason = 'followup_owner_ineligible';
    else [owner, ownerRole] = [found[0], roles.includes(found[0].role) ? found[0].role : roles[0]];
  } else if (envRole) {
    ownerSource = 'env';
    const holders = ROLES.includes(envRole) ? roster.filter(member => followupRoles(member).includes(envRole)) : [];
    if (!ROLES.includes(envRole)) reason = 'followup_role_invalid';
    else if (holders.length !== 1) reason = holders.length ? 'followup_owner_ambiguous' : 'followup_owner_unresolved';
    else [owner, ownerRole] = [holders[0], envRole];
  } else reason = 'followup_owner_unresolved';
  const blockedReason = reason || (dueMinutes === null ? 'followup_due_rule_invalid' : !sendWindow ? 'followup_send_window_invalid' : null);
  return policy({ enabled: !blockedReason, ownerId: owner ? owner.id : null, ownerRole, ownerSource, dueMinutes, dueSource, sendWindow }, blockedReason);
}

const denverParts = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FOLLOWUP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
// When a follow-up from `from` is due: dueMinutes later, moved to the next opening of the
// Denver send window when that lands outside it. Null unless the policy is enabled.
export function followupDueAt(followup, from) {
  const at = from instanceof Date ? from.getTime() : typeof from === 'string' && ISO.test(from) ? Date.parse(from) : NaN;
  if (!followup?.enabled || !validDueMinutes(followup.dueMinutes) || !validSendWindow(followup.sendWindow) || !Number.isFinite(at)) return null;
  const due = at + followup.dueMinutes * 60000, parts = denverParts(due), minute = Number(parts.hour) * 60 + Number(parts.minute);
  const { startHour, endHour } = followup.sendWindow, date = `${parts.year}-${parts.month}-${parts.day}`;
  if (minute >= startHour * 60 && minute < endHour * 60) return new Date(due).toISOString();
  return localInstant(minute < startHour * 60 ? date : addDays(date, 1), `${String(startHour).padStart(2, '0')}:00`);
}

// operations_settings/followups: read through the revisioned dispatch reader; writes commit
// the settings (currentDocument.updateTime, or exists:false for the first save) with the
// SEC-02 audit entry. A stale updateTime answers 400 FAILED_PRECONDITION on the Firestore
// REST API (409/412 elsewhere); every one of those is a revision conflict.
export function followupSettingsStorage(env, fetcher = firestoreFetch) {
  const documents = dispatchStorage(env, fetcher);
  return {
    async read() {
      try { return await documents.read(FOLLOWUP_SETTINGS_COLLECTION, FOLLOWUP_SETTINGS_ID); }
      catch { throw fail('storage_unavailable', 'The follow-up settings could not be loaded. Retry shortly.', 503); }
    },
    async commit(writes) {
      let response;
      try {
        response = await fetcher(env, `${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({
          writes: writes.map(write => ({ update: { name: `${ROOT}/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) }, updateMask: { fieldPaths: Object.keys(write.patch) }, currentDocument: write.revision ? { updateTime: write.revision } : { exists: false } })),
        }) });
      } catch { throw fail('outcome_unknown', 'The save could not be verified. Retry the same save to safely check whether it applied.', 503); }
      if (response.ok) return response.json().catch(() => ({}));
      const body = await response.json().catch(() => null);
      if ([409, 412].includes(response.status) || response.status === 400 && ['FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(body?.error?.status)) throw fail('revision_conflict', 'The follow-up settings changed while saving. Load the latest before saving again.', 409);
      throw fail('outcome_unknown', 'The save could not be verified. Retry the same save to safely check whether it applied.', 503);
    },
  };
}

// The live policy for portal.rules and the settings screen. A settings read failure blocks
// only the follow-up policy (followup_settings_unavailable), never the inbound reply rule.
export async function readFollowupPolicy(env, roster, store) {
  const settings = await store.read().catch(() => undefined);
  return { settings, ...followupPolicy(env, [...roster.members, ...roster.others], settings) };
}

function sendWindowInput(value) {
  if (!validSendWindow(value)) throw fail('invalid', `Choose a contact window between ${FOLLOWUP_WINDOW.earliest} AM and ${FOLLOWUP_WINDOW.latest - 12} PM Denver time that starts before it ends.`);
  return { startHour: value.startHour, endHour: value.endHour, timeZone: FOLLOWUP_TIME_ZONE };
}
function validateInput(input) {
  if (!record(input) || Object.keys(input).some(name => !INPUT_KEYS.includes(name))) throw fail('invalid', 'The follow-up settings request has unsupported fields. Refresh and try again.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('invalid', 'The save needs a request id. Refresh and try again.');
  if (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 100) throw fail('invalid', 'The save needs the settings revision you reviewed. Refresh and try again.');
  if (input.ownerId !== null && (typeof input.ownerId !== 'string' || !input.ownerId.trim() || input.ownerId.length > 80)) throw fail('invalid', 'Choose a follow-up owner or the Cloudflare fallback.');
  if (!validDueMinutes(input.dueMinutes)) throw fail('invalid', `Follow-ups must be due between ${FOLLOWUP_DUE.min} minutes and ${FOLLOWUP_DUE.max / 1440} days after the walkthrough or call, in whole minutes.`);
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) throw fail('invalid', 'The reason must be text of at most 500 characters.');
  return { ownerId: input.ownerId === null ? null : input.ownerId.trim(), dueMinutes: input.dueMinutes, sendWindow: sendWindowInput(input.sendWindow), reason: (input.reason || '').trim() };
}
const savedFields = settings => record(settings) ? { ownerId: settings.ownerId ?? null, dueMinutes: settings.dueMinutes ?? null, sendWindow: record(settings.sendWindow) ? { startHour: settings.sendWindow.startHour, endHour: settings.sendWindow.endHour, timeZone: settings.sendWindow.timeZone ?? FOLLOWUP_TIME_ZONE } : null } : null;

// Owner-only settings service behind /api/operations-followup-settings. Business users may
// read the policy; only settings.manage (the configured owner) can change it.
export function createFollowupSettingsService({ store, roster, env = {}, now = () => new Date() }) {
  function view(session, members, settings, policy, asOf) {
    const saved = savedFields(settings);
    return { ok: true, authority: 'employee_hub', timeZone: FOLLOWUP_TIME_ZONE, policyEnabled: followupPolicyEnabled(env), staffMembers: operationsStaffMembersEnabled(env),
      canEdit: can(session, 'settings.manage', env), revision: settings?.revision || '',
      settings: saved && { ...saved, updatedBy: typeof settings.updatedBy === 'string' ? settings.updatedBy : null, updatedAt: typeof settings.updatedAt === 'string' ? settings.updatedAt : null },
      fallback: { ownerId: envText(env?.EGC_OPERATIONS_FOLLOWUP_OWNER_ID) || null, role: envText(env?.EGC_OPERATIONS_FOLLOWUP_ROLE).toLowerCase() || null },
      followup: policy.followup,
      candidates: members.filter(member => followupRoles(member).length).map(member => ({ id: member.id, name: String(member.name || member.id), role: followupRoles(member).includes(member.role) ? member.role : followupRoles(member)[0], businessAccess: member.businessAccess !== false })),
      limits: { dueMinutes: FOLLOWUP_DUE, sendWindow: { earliest: FOLLOWUP_WINDOW.earliest, latest: FOLLOWUP_WINDOW.latest } },
      coverage: { complete: settings !== undefined, asOf } };
  }
  const requireReader = session => {
    if (!session?.user) throw fail('sign_in_required', 'Sign in to the Employee Hub.', 401);
    if (!hasBusinessAccess(session)) throw fail('forbidden', 'Only the owner and managers can review the follow-up policy.', 403);
  };

  return {
    async read(session) {
      requireReader(session);
      const people = await roster(), date = now(), { settings, ...policy } = await readFollowupPolicy(env, people, store);
      if (settings === undefined) throw fail('storage_unavailable', 'The follow-up settings could not be loaded. Retry shortly.', 503);
      return view(session, people.members, settings, policy, date.toISOString());
    },

    async save(session, input) {
      requireReader(session);
      if (!can(session, 'settings.manage', env)) throw fail('forbidden', 'Only the owner can change who owns follow-ups.', 403);
      const next = validateInput(input), requestId = input.requestId.toLowerCase(), date = now(), nowIso = date.toISOString(), actor = key(session.user);
      const fingerprint = await sha256(canonical({ actor, input: { ...input, requestId } }));
      const people = await roster(), current = await store.read();
      const result = settings => view(session, people.members, settings, followupPolicy(env, [...people.members, ...people.others], settings), nowIso);
      if (current?.requestId === requestId) {
        if (current.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request id was already used for a different change. Refresh and try again.', 409);
        return { ...result(current), requestId, replayed: true };
      }
      if ((current?.revision || '') !== input.expectedRevision) throw fail('revision_conflict', 'The follow-up settings changed since you opened them. Load the latest before saving.', 409, { currentRevision: current?.revision || '' });
      let ownerId = null;
      if (next.ownerId) {
        const member = people.members.find(item => key(item.id) === key(next.ownerId));
        if (!member && people.others.some(item => item.staffOnly === true && key(item.id) === key(next.ownerId))) throw fail('owner_staff_disabled', 'That person holds the sales or phone role, but staff owners are off. Set EGC_OPERATIONS_STAFF_MEMBERS to true in Cloudflare first.', 409);
        if (!member || !followupRoles(member).length) throw fail('owner_ineligible', 'Choose an active Hub member with the owner, manager, sales or phone role.', 409);
        ownerId = member.id;
      }
      const before = savedFields(current), after = { ownerId, dueMinutes: next.dueMinutes, sendWindow: next.sendWindow };
      if (before && canonical(before) === canonical(after)) return { ...result(current), requestId, unchanged: true };
      const patch = { ...after, updatedBy: actor, updatedAt: nowIso, requestId, fingerprint, version: 1 };
      const audit = auditWrite({ actor: { id: actor, kind: 'human', role: session.role || null }, via: 'hub', action: 'operations_settings.followups.update',
        entity: { collection: FOLLOWUP_SETTINGS_COLLECTION, id: FOLLOWUP_SETTINGS_ID }, before, after, requestId, reason: next.reason || null, now: nowIso });
      // The audit id hashes the requestId with the commit time, so a retry at another instant
      // would get another id. What keeps a retry from adding a second entry is the settings
      // document's precondition (updateTime, or exists:false for the first save) in this same
      // commit, plus the requestId replay check above.
      let saved;
      try { saved = await store.commit([{ collection: FOLLOWUP_SETTINGS_COLLECTION, id: FOLLOWUP_SETTINGS_ID, ...(current ? { revision: current.revision } : {}), patch }, audit]); }
      catch (error) {
        // A lost reply or a racing retry of this same request may already have applied it.
        const latest = await store.read().catch(() => null);
        if (latest?.requestId === requestId && latest.fingerprint === fingerprint) return { ...result(latest), requestId };
        throw error;
      }
      const revision = saved?.writeResults?.[0]?.updateTime;
      return { ...result(typeof revision === 'string' && revision ? { ...patch, revision } : await store.read()), requestId };
    },
  };
}
