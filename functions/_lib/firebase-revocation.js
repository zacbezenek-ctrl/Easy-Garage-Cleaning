import { dispatchStorage } from './dispatch-storage.js';
import { firebaseAdminConfigured, identityToolkitFetch } from './firebase-service-account.js';

// A Firebase session minted from /api/firebase-session keeps its role and
// business_access claims for as long as its refresh token lives; ending the
// Hub cookie does not end it. Whenever staff access changes, Identity Toolkit
// accounts:update {localId, validSince} (the REST form of the Admin SDK's
// revokeRefreshTokens) invalidates every refresh token issued before the
// change. An ID token already issued stays valid until it expires (at most one
// hour); Firestore rules do not check revocation. A revocation that cannot be
// completed is recorded in a server-only state document, surfaced in
// integration-status and retried; the Hub change that caused it is never
// blocked or rolled back.

const PROJECT_ID = 'egcw-1ec83';
const ACCOUNTS_UPDATE = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`;
export const FIREBASE_REVOCATION_COLLECTION = 'firebaseSessionRevocations';
const STATE_ID = 'state';
export const FIREBASE_REVOCATION_RETRY_MS = 15 * 60 * 1000;
export const FIREBASE_REVOCATION_PROBE_MS = 60 * 60 * 1000;
// Maintenance runs after the response (waitUntil allows about 30 s), so a pass
// makes at most three sequential calls of at most 8 s (token exchange
// included), each after a state read of at most 3 s; the rest stay queued.
export const FIREBASE_REVOCATION_MAX_CALLS = 3;
// integration-status answers 'unavailable' instead of holding the Hub render
// on a slow state read.
export const FIREBASE_REVOCATION_READ_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 8000;
const MAX_PENDING = 500;
// How long a success is remembered per uid, so neither a stale retry nor an
// older failure saved late can move validSince backwards.
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000;
// Never minted by /api/firebase-session (staff uids start with 'hub:'), so an
// update of it can only answer USER_NOT_FOUND (permission works) or an error.
export const FIREBASE_REVOCATION_PROBE_UID = 'egc-revocation-probe';
// The static roster snapshot is compared only where the production staff
// configuration is served: a preview or local deployment holding the same
// service account but another HUB_AUTH_USERS_JSON would otherwise read every
// production person as removed and revoke them.
const PRODUCTION_HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev)$/;
const REASONS = new Set(['account_status', 'static_removed', 'static_changed']);
const ERRORS = new Set(['permission_denied', 'unavailable', 'rejected']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validUid = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const optionalIso = value => value === undefined || value === null || value === '' || typeof value === 'string' && ISO.test(value);
const errorCode = error => String(error?.code || '').replace(/^firebase_revocation_/, '') || 'unavailable';
const time = iso => Date.parse(iso);
const seconds = iso => Math.floor(time(iso) / 1000);
const byUid = (left, right) => left.uid.localeCompare(right.uid);
const byIntent = (left, right) => byUid(left, right) || left.at.localeCompare(right.at);
const log = (level, event, details = {}) => console[level](JSON.stringify({ event, ...details }));
const backlog = () => fail('firebase_revocation_backlog_full', 'Too many Firebase session revocations are pending. Grant the server account the Firebase Authentication Admin role.');

const MESSAGES = {
  revocation_pending: 'The account change is saved. Ending this person\'s earlier Firebase data sessions is pending; it retries on the next Hub load, at most every 15 minutes. If it stays pending, grant the server account the Firebase Authentication Admin role.',
  revocation_failed: 'The account change is saved, but ending this person\'s earlier Firebase data sessions could not be confirmed or queued for retry. Check Integrations before relying on this change.',
  not_configured: 'The account change is saved. Ending earlier Firebase data sessions needs the server service account.',
};
const outcome = (status, error = '') => ({ status, ...(MESSAGES[status] ? { message: MESSAGES[status] } : {}), ...(error ? { error } : {}) });

/** The Firebase uid /api/firebase-session mints for a Hub user. */
export const firebaseStaffUid = user => `hub:${String(user).toLowerCase()}`.trim().slice(0, 128);
const uidsOf = users => Array.isArray(users) ? users.slice(0, 20).map(firebaseStaffUid) : [];

/** The first whole second after `date`. Identity Toolkit keeps a session whose
 * auth_time (whole seconds) is not before validSince, so revoking for a change
 * saved at `date` must start after that second. */
export const firebaseRevocationTime = date => new Date((Math.floor(date.getTime() / 1000) + 1) * 1000).toISOString();

/** Whether a request reached the production deployment, whose staff
 * configuration the static roster snapshot records. */
export function reconcilesStaffRoster(url) {
  try { return PRODUCTION_HOST.test(new URL(url).host); }
  catch { return false; }
}

/** Static (configured) staff as {uid, fingerprint}; a changed fingerprint means
 * the claims already minted for that person are stale. */
export function staticStaffRoster(profiles) {
  const roster = new Map();
  for (const profile of profiles) {
    const uid = firebaseStaffUid(profile.user);
    if (roster.has(uid)) throw fail('firebase_revocation_roster_ambiguous', 'Staff identities need review before Firebase sessions can be reconciled.');
    roster.set(uid, `${String(profile.role || 'crew')}|${profile.businessAccess === true}`);
  }
  return [...roster].sort(([left], [right]) => left.localeCompare(right)).map(([uid, fingerprint]) => ({ uid, fingerprint }));
}

/** revoke(uid, validSinceSeconds) against Identity Toolkit. Resolves when no
 * refresh token issued before validSince can be used; throws a coded error. */
export function identityToolkitRevoker(env, fetcher = identityToolkitFetch) {
  return async (uid, validSince) => {
    let response;
    try {
      response = await fetcher(env, ACCOUNTS_UPDATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid, validSince: String(validSince) }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch { throw fail('firebase_revocation_unavailable', 'Firebase could not be reached to end staff sessions.'); }
    if (response.ok) return 'revoked';
    const body = await response.json().catch(() => null);
    // Someone who never opened Firebase data has no refresh token to revoke.
    if (response.status === 400 && /^USER_NOT_FOUND\b/.test(String(body?.error?.message || ''))) return 'no_firebase_user';
    if ([401, 403].includes(response.status)) throw fail('firebase_revocation_permission_denied', 'The server account is not allowed to end Firebase sessions.');
    if (response.status === 429 || response.status >= 500) throw fail('firebase_revocation_unavailable', 'Firebase could not end staff sessions right now.');
    throw fail('firebase_revocation_rejected', 'Firebase rejected the staff session revocation.');
  };
}

function unreadable() {
  return fail('firebase_revocation_state_unreadable', 'The Firebase session revocation record could not be verified. It was not changed.');
}

// Rejects when the read has not settled within ms; a late answer is ignored.
function within(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('firebase_revocation_state_timeout', 'The Firebase session revocation record did not load in time.')), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function validPending(entry) {
  return isRecord(entry) && validUid(entry.uid) && REASONS.has(entry.reason) && ISO.test(entry.requestedAt || '') &&
    Number.isInteger(entry.attempts) && entry.attempts >= 0 && (entry.lastAttemptAt === '' || ISO.test(entry.lastAttemptAt || '')) &&
    (entry.lastError === '' || ERRORS.has(entry.lastError));
}
const validIntent = entry => isRecord(entry) && validUid(entry.uid) && REASONS.has(entry.reason) && ISO.test(entry.at || '');
const validRevoked = entry => isRecord(entry) && validUid(entry.uid) && ISO.test(entry.through || '');
const validList = (list, valid, key) => Array.isArray(list) && list.length <= MAX_PENDING && list.every(valid) && new Set(list.map(key)).size === list.length;

// A malformed record is never treated as empty or overwritten. intents and
// revoked are optional (absent reads as none).
export function decodeFirebaseRevocationState(row) {
  if (row === null) return { revision: undefined, pending: [], intents: [], revoked: [], staticRoster: null, verifiedAt: '', probedAt: '', probeError: '' };
  if (!isRecord(row)) throw unreadable();
  const pending = row.pending ?? [], intents = row.intents ?? [], revoked = row.revoked ?? [], roster = row.staticRoster ?? null;
  if (!validList(pending, validPending, entry => entry.uid) || !validList(intents, validIntent, entry => `${entry.uid}|${entry.at}`) ||
      !validList(revoked, validRevoked, entry => entry.uid)) throw unreadable();
  if (roster !== null && (!Array.isArray(roster) || !roster.every(entry => isRecord(entry) && validUid(entry.uid) && typeof entry.fingerprint === 'string' && entry.fingerprint.length <= 80) ||
      new Set(roster.map(entry => entry.uid)).size !== roster.length)) throw unreadable();
  if (!optionalIso(row.verifiedAt) || !optionalIso(row.probedAt) || !(row.probeError == null || row.probeError === '' || ERRORS.has(row.probeError))) throw unreadable();
  return {
    revision: row.revision, pending: pending.map(entry => ({ ...entry })), intents: intents.map(({ uid, reason, at }) => ({ uid, reason, at })),
    revoked: revoked.map(({ uid, through }) => ({ uid, through })), staticRoster: roster && roster.map(({ uid, fingerprint }) => ({ uid, fingerprint })),
    verifiedAt: row.verifiedAt || '', probedAt: row.probedAt || '', probeError: row.probeError || '',
  };
}

// firebaseRevocationError names why revocation is not verified: a missing IAM
// grant (permission_denied) wins over a transient provider failure. An
// unsettled intent is a revocation still owed, like a queued one.
export function firebaseRevocationSummary(state) {
  const pending = new Set([...state.pending, ...state.intents].map(entry => entry.uid)).size;
  const value = pending ? 'revocation_pending' : state.verifiedAt ? 'verified' : 'unverified';
  const errors = pending ? state.pending.map(entry => entry.lastError) : value === 'unverified' ? [state.probeError] : [];
  const error = errors.includes('permission_denied') ? 'permission_denied' : errors.find(Boolean) || '';
  return { firebaseRevocation: value === 'verified', firebaseRevocationState: value, firebaseRevocationPending: pending, firebaseRevocationError: error };
}

// results: [{uid, reason, ok, attempted, retry, error, covers, intents, skip}]
// applied to fresh state. A success clears only work requested at or before
// the instant it revoked (covers) and is remembered per uid (revoked), so an
// older request's failure saved late is not queued, and a queued time never
// moves back. A retry of an entry that is already gone is not re-added. The
// intents a result carries are settled: its call covered them, or its failure
// is queued at a time after their change.
function applyResults(state, results, now) {
  const pending = new Map(state.pending.map(entry => [entry.uid, entry]));
  const revoked = new Map(state.revoked.map(entry => [entry.uid, entry.through]));
  const settled = new Set(results.filter(result => !result.skip).flatMap(result => (result.intents || []).map(at => `${result.uid}|${at}`)));
  let verifiedAt = state.verifiedAt;
  for (const result of results) {
    if (result.skip) continue;
    const entry = pending.get(result.uid), through = revoked.get(result.uid);
    if (result.ok) {
      if (result.attempted) verifiedAt ||= now;
      if (!through || time(result.covers) > time(through)) revoked.set(result.uid, result.covers);
      if (entry && time(entry.requestedAt) <= time(result.covers)) pending.delete(result.uid);
      continue;
    }
    if (result.retry ? !entry : !entry && through && time(through) >= time(now)) continue;
    pending.set(result.uid, {
      uid: result.uid,
      reason: result.retry ? entry.reason : result.reason,
      requestedAt: result.retry || entry && time(entry.requestedAt) > time(now) ? entry.requestedAt : now,
      attempts: (entry?.attempts || 0) + (result.attempted ? 1 : 0),
      lastAttemptAt: result.attempted ? now : result.retry ? entry.lastAttemptAt : '',
      lastError: result.attempted ? result.error : entry?.lastError || '',
    });
  }
  if (pending.size > MAX_PENDING) throw backlog();
  const horizon = time(now) - REVOKED_TTL_MS;
  const remembered = [...revoked].filter(([, through]) => time(through) >= horizon).sort(([, left], [, right]) => time(right) - time(left)).slice(0, MAX_PENDING);
  return {
    ...state,
    pending: [...pending.values()].sort(byUid),
    intents: state.intents.filter(intent => !settled.has(`${intent.uid}|${intent.at}`)),
    revoked: remembered.map(([uid, through]) => ({ uid, through })).sort(byUid),
    verifiedAt,
  };
}

const statePatch = state => ({ pending: state.pending, intents: state.intents, revoked: state.revoked, staticRoster: state.staticRoster, verifiedAt: state.verifiedAt, probedAt: state.probedAt, probeError: state.probeError });

/** store: {read(collection,id), commit(writes)} (dispatchStorage shape);
 * revoke: (uid, validSinceSeconds) => Promise, e.g. identityToolkitRevoker. */
export function createFirebaseRevocationService({ store, revoke }) {
  const read = async () => decodeFirebaseRevocationState(await store.read(FIREBASE_REVOCATION_COLLECTION, STATE_ID));

  // Compare-and-set on the state document; apply() is re-run on fresh state
  // after a conflict, so no provider call is ever repeated to save a result.
  // Firestore answers a stale updateTime with FAILED_PRECONDITION (HTTP 400),
  // which dispatchStorage reports as an unknown outcome, so that is re-read and
  // re-applied too; a response lost after the write landed at most counts one
  // attempt twice. No change against state read before the response (known)
  // proves nothing, so that is checked once more on fresh state.
  async function save(apply, now, known = null) {
    const same = (left, right) => JSON.stringify(statePatch(left)) === JSON.stringify(statePatch(right));
    let current = known;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      current ??= await read();
      let next = apply(current);
      if (current === known && same(next, current)) { current = await read(); next = apply(current); }
      if (same(next, current)) return current;
      try {
        await store.commit([{ collection: FIREBASE_REVOCATION_COLLECTION, id: STATE_ID, revision: current.revision, patch: { ...statePatch(next), updatedAt: now } }]);
        return next;
      } catch (error) {
        if (!['dispatch_revision_conflict', 'dispatch_outcome_unknown'].includes(error?.code) || attempt === 2) throw error;
        current = null;
      }
    }
  }

  // since: the ISO instant whose earlier sessions end (validSince, in seconds).
  async function call(uid, since) {
    try { await revoke(uid, seconds(since)); return { ok: true, attempted: true, covers: since }; }
    catch (error) { return { ok: false, attempted: true, error: ERRORS.has(errorCode(error)) ? errorCode(error) : 'unavailable' }; }
  }

  // Maintenance works from state read before the response, so each item is
  // re-checked on fresh state just before its call: work another request
  // finished is skipped, a success already covering the time is not repeated,
  // and a retry sends the latest queued time, so validSince never moves back.
  async function attempt(item, now) {
    let fresh;
    try { fresh = await within(read(), FIREBASE_REVOCATION_READ_TIMEOUT_MS); }
    catch { return { ok: false, attempted: false }; }
    const entry = fresh.pending.find(queued => queued.uid === item.uid);
    if (item.retry && !entry) return { ok: false, attempted: false };
    if (item.owed && !fresh.intents.some(intent => intent.uid === item.uid && item.intents.includes(intent.at))) return { skip: true };
    const since = item.retry ? entry.requestedAt : now;
    const through = fresh.revoked.find(done => done.uid === item.uid)?.through;
    if (through && time(through) >= time(since)) return { ok: true, attempted: false, covers: through };
    return call(item.uid, since);
  }

  return {
    read,

    /** Intent first: before an access change for users is saved at `at`,
     * record that their sessions must end. The request that saves the change
     * settles the intent (revokeStaff with intentAt, or settle when nothing
     * changed); one it never settles is owed after the retry window (maintain). */
    async intend(users, reason, at) {
      if (!Array.isArray(users) || !ISO.test(at) || !REASONS.has(reason)) throw fail('firebase_revocation_invalid', 'Firebase session revocation needs a valid reason and time.');
      const uids = [...new Set(users.map(firebaseStaffUid))];
      await save(state => {
        const intents = [...state.intents.filter(intent => !(uids.includes(intent.uid) && intent.at === at)), ...uids.map(uid => ({ uid, reason, at }))];
        if (intents.length > MAX_PENDING) throw backlog();
        return { ...state, intents: intents.sort(byIntent) };
      }, at);
    },

    /** The change was refused or changed nothing: its intent needs no call. */
    async settle(users, at, now) {
      if (!Array.isArray(users) || !ISO.test(at) || !ISO.test(now)) throw fail('firebase_revocation_invalid', 'Firebase session revocation needs a valid time.');
      const uids = new Set(users.map(firebaseStaffUid));
      await save(state => ({ ...state, intents: state.intents.filter(intent => !(uids.has(intent.uid) && intent.at === at)) }), now);
    },

    /** Revoke after an account status or role change saved before `now`,
     * settling the intent recorded at intentAt. Only invalid input throws
     * (before any call); provider and storage failures become the returned
     * outcome, because the account change is already saved. */
    async revokeStaff(users, reason, now, intentAt = '') {
      if (!Array.isArray(users) || !ISO.test(now) || !REASONS.has(reason) || intentAt && !ISO.test(intentAt)) throw fail('firebase_revocation_invalid', 'Firebase session revocation needs a valid reason and time.');
      const results = [];
      for (const uid of new Set(users.map(firebaseStaffUid))) results.push({ uid, reason, retry: false, intents: intentAt ? [intentAt] : [], ...await call(uid, now) });
      const failed = results.filter(result => !result.ok);
      try { await save(state => applyResults(state, results, now), now); }
      catch (error) {
        log('error', 'firebase_revocation_unrecorded', { uids: results.map(result => result.uid), failed: failed.length, intent: Boolean(intentAt), code: String(error?.code || 'unknown') });
        // The intent recorded before the change still owes this revocation.
        if (failed.length) return outcome(intentAt ? 'revocation_pending' : 'revocation_failed', failed[0].error);
      }
      if (!failed.length) return outcome('revoked');
      log('warn', 'firebase_revocation_pending', { count: failed.length, reason, error: failed[0].error });
      return outcome('revocation_pending', failed[0].error);
    },

    /** Reconcile configured staff (removed or changed people are revoked at
     * `now`; profiles null leaves the roster snapshot alone), revoke owed
     * intents at `now`, retry due pending revocations with the time they were
     * requested and, until one call has proven the IAM grant, probe it. Does
     * no I/O when there is nothing to do. */
    async maintain(profiles, now, known = null) {
      if (!ISO.test(now)) throw fail('firebase_revocation_invalid', 'Firebase session maintenance needs a valid time.');
      const at = time(now), roster = profiles === null ? null : staticStaffRoster(profiles);
      const current = new Map((roster || []).map(entry => [entry.uid, entry.fingerprint]));
      const state = known || await read();
      const changedFrom = snapshot => roster === null ? [] : (snapshot || []).filter(entry => current.get(entry.uid) !== entry.fingerprint)
        .map(entry => ({ uid: entry.uid, reason: current.has(entry.uid) ? 'static_changed' : 'static_removed', retry: false, intents: [] }));
      const rosterChanged = roster !== null && JSON.stringify(state.staticRoster) !== JSON.stringify(roster);
      const items = changedFrom(state.staticRoster);
      // An intent its request never settled (it stopped after the change may
      // have landed) is owed once the retry window has passed. It is revoked
      // at this pass's time, which is after the change whenever it landed.
      for (const intent of state.intents.filter(intent => at - time(intent.at) >= FIREBASE_REVOCATION_RETRY_MS)) {
        const item = items.find(work => work.uid === intent.uid);
        if (item) item.intents.push(intent.at);
        else items.push({ uid: intent.uid, reason: intent.reason, retry: false, owed: true, intents: [intent.at] });
      }
      const covered = new Set(items.map(item => item.uid));
      items.push(...state.pending.filter(entry => !covered.has(entry.uid) && (!entry.lastAttemptAt || at - time(entry.lastAttemptAt) >= FIREBASE_REVOCATION_RETRY_MS))
        .map(entry => ({ uid: entry.uid, reason: entry.reason, retry: true, intents: [] })));
      const probe = !state.verifiedAt && !state.pending.length && !items.length && (!state.probedAt || at - time(state.probedAt) >= FIREBASE_REVOCATION_PROBE_MS);
      if (!rosterChanged && !items.length && !probe) return firebaseRevocationSummary(state);
      const results = [];
      for (const [index, item] of items.entries()) {
        results.push({ ...item, ...(index < FIREBASE_REVOCATION_MAX_CALLS ? await attempt(item, now) : { ok: false, attempted: false }) });
      }
      const probed = probe ? await call(FIREBASE_REVOCATION_PROBE_UID, now) : null;
      const next = await save(fresh => {
        // Never drop a person from the snapshot without revoking or queueing them.
        const handled = new Set(results.filter(result => !result.skip).map(result => result.uid));
        const missed = changedFrom(fresh.staticRoster).filter(change => !handled.has(change.uid)).map(change => ({ ...change, ok: false, attempted: false }));
        const applied = { ...applyResults(fresh, [...results, ...missed], now), ...(roster === null ? {} : { staticRoster: roster }) };
        if (!probed) return applied;
        return { ...applied, probedAt: now, probeError: probed.ok ? '' : probed.error, verifiedAt: probed.ok ? applied.verifiedAt || now : applied.verifiedAt };
      }, now, state);
      const failed = results.filter(result => !result.skip && !result.ok);
      if (failed.length) log('warn', 'firebase_revocation_pending', { count: next.pending.length, error: failed.find(result => result.error)?.error || 'queued' });
      if (probed && !probed.ok) log('warn', 'firebase_revocation_unverified', { error: probed.error });
      return firebaseRevocationSummary(next);
    },
  };
}

/** The production service, or null when no real service account is configured
 * (the unit-test Firestore key cannot administer Firebase Auth). */
export function firebaseRevocations(env, { fetcher = identityToolkitFetch, storage = dispatchStorage } = {}) {
  if (!firebaseAdminConfigured(env)) return null;
  return createFirebaseRevocationService({ store: storage(env), revoke: identityToolkitRevoker(env, fetcher) });
}

/** Before an account change is saved: records the intent and returns its time,
 * or '' when revocation is not configured or the intent could not be recorded
 * (the change goes ahead either way). Never throws. */
export async function recordStaffFirebaseIntent(service, users, reason, at) {
  if (!service) return '';
  try { await service.intend(users, reason, at); return at; }
  catch (error) {
    log('warn', 'firebase_revocation_intent_unrecorded', { uids: uidsOf(users), code: String(error?.code || 'unknown') });
    return '';
  }
}

/** After a refused or no-op account change: drops its intent. An intent that
 * cannot be dropped is revoked later, which is harmless. Never throws. */
export async function settleStaffFirebaseIntent(service, users, intentAt, now) {
  if (!service || !intentAt) return;
  try { await service.settle(users, intentAt, now); }
  catch (error) { log('warn', 'firebase_revocation_intent_unsettled', { uids: uidsOf(users), code: String(error?.code || 'unknown') }); }
}

/** Account status/role change: never throws and never blocks the change. */
export async function revokeStaffFirebaseSessions(service, users, reason, now, intentAt = '') {
  if (!service) return outcome('not_configured');
  try { return await service.revokeStaff(users, reason, now, intentAt); }
  catch (error) {
    log('error', 'firebase_revocation_unrecorded', { uids: uidsOf(users), code: String(error?.code || 'unknown') });
    return outcome('revocation_failed');
  }
}

/** integration-status fields for business users. profiles: () => staff
 * profiles, or null where the production staff configuration is not served
 * (reconcilesStaffRoster). Maintenance runs after the response through defer
 * (context.waitUntil) when available. */
export async function firebaseRevocationStatus(service, profiles, now, { defer = null, timeoutMs = FIREBASE_REVOCATION_READ_TIMEOUT_MS } = {}) {
  const unknown = (state, error = '') => ({ firebaseRevocation: false, firebaseRevocationState: state, firebaseRevocationPending: null, firebaseRevocationError: error });
  if (!service) return unknown('not_configured');
  // Unreadable staff configuration means removed staff are not being revoked,
  // so revocation is not reported as working; pending retries still run.
  let staff = null, staffError = '';
  if (profiles) {
    try { staff = profiles(); staticStaffRoster(staff); }
    catch (error) {
      staff = null; staffError = 'staff_config';
      log('warn', 'firebase_revocation_staff_config', { code: String(error?.code || 'unknown') });
    }
  }
  let state;
  try { state = await within(service.read(), timeoutMs); }
  catch (error) {
    log('warn', 'firebase_revocation_state_unavailable', { code: String(error?.code || 'unknown') });
    return unknown('unavailable', staffError);
  }
  const answer = summary => staffError ? { ...summary, firebaseRevocation: false, firebaseRevocationState: 'unavailable', firebaseRevocationError: staffError } : summary;
  const maintenance = Promise.resolve().then(() => service.maintain(staff, now, state)).catch(error => {
    log('warn', 'firebase_revocation_maintenance_failed', { code: String(error?.code || 'unknown') });
    return null;
  });
  if (defer) { defer(maintenance); return answer(firebaseRevocationSummary(state)); }
  return answer((await maintenance) || firebaseRevocationSummary(state));
}
