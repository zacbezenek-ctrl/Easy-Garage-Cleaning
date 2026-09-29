import { firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { employeeVaultReadOnly } from './employee-vault-key.js';
import { commitVaultDocuments, opaqueId, readCollectionRecords, sealedFields, vaultDigest } from './employee-vault.js';
import {
  employeeAccountsConfigured, employeeInvitationStore, employeePasswordMatches, employeePasswordProblem, employeeSessionProfile,
  isReservedEmployeeUsername, pendingSignInReset, publicEmployeeAccount, sealedAccountFields,
} from './employee-accounts.js';
import { createStaffReset, namedStaffRole } from './staff-invitation-service.js';
import { STAFF_ROLES, can, sanitizeStaffRoles, staffPasswordResetEnabled } from './staff-roles.js';
import { isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { appendHistory, canonicalJson, effectivePayRate, firstRateFrom, payChange, payProfile, personKey, storedPayRates, withProfile } from './staff-directory.js';
import { addDays, denverToday } from './dispatch-time.js';
import { denverWorkDate, payAmount, timesheetWeekStart } from './timesheet-week.js';
import { PAYROLL_WEEK_EXPORTS, weekExported } from './payroll-week-exports.js';
import { firebaseRevocationTime, recordStaffFirebaseIntent, revokeStaffFirebaseSessions, settleStaffFirebaseIntent } from './firebase-revocation.js';
import { payHidden, seesOthersPay } from './pay-visibility.js';

// STAFF-ACCESS (EGC_STAFF_PASSWORD_RESET): staff sign-in resets, self-service password changes, account approval with a
// role and (owner) a starting rate, and the owner's 'Apply rate to open weeks'. Every change is one atomic commit of the
// sealed account, profile or timecards with a create-only receipt and a SEC-02 audit entry; every account change ends
// the person's Hub sessions (sessionVersion) and their Firebase data sessions (firebase-revocation.js), intent first.
// Nothing is sent to anyone: a reset link is returned for the manager to copy.
export const STAFF_ACCESS_RECEIPTS = 'staffAccessOperations';
// /api/staff-setup accepts only this origin, so the reset link is always on it.
export const STAFF_RESET_ORIGIN = 'https://easygaragecleaning.com';
// Timecards changed by one 'Apply rate' commit, well under Firestore's 500 writes.
export const APPLY_RATE_LIMIT = 150;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EDITABLE_ROLES = STAFF_ROLES.filter(role => role !== 'owner');
const PAY_TYPES = ['hourly', 'salary'];
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'staff_access_' + code, status, ...(details ? { details } : {}) });
const payRefused = message => Object.assign(new Error(message), { code: 'pay_owner_only', status: 403 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => personKey(left) !== '' && personKey(left) === personKey(right);
const auditId = value => personKey(value).replace(/[^a-z0-9_.@:+-]/g, '_');
const auditEntity = value => personKey(value).replace(/[^a-z0-9_.:-]/g, '_');
const text = (value, limit) => String(value ?? '').trim().slice(0, limit);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

function keysOnly(input, allowed) {
  if (!record(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail('invalid_request', 'The request contains unsupported fields. Refresh and try again.');
}
function requestIdOf(input) {
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('invalid_request', 'The change needs a request id. Refresh and try again.');
  return input.requestId.toLowerCase();
}
function usernameOf(input) {
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 80) throw fail('invalid_request', 'Choose a staff member.');
  return input.username.trim();
}
function reasonOf(input) {
  if (input.reason === undefined) return '';
  if (typeof input.reason !== 'string' || input.reason.length > 500) throw fail('invalid_request', 'The reason must be text of at most 500 characters.');
  return input.reason.trim();
}
function expectedUserOf(input, session) {
  if (input.expectedUser === undefined) return;
  if (typeof input.expectedUser !== 'string' || !same(input.expectedUser, session.user)) throw fail('account_changed', 'This change was made while signed in as another account. Sign in as that account to retry it, or discard it.', 401);
}
function startingRate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 500 || Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw fail('invalid_pay', 'Enter the starting hourly rate: more than $0 and at most $500, exact to the cent.');
  return Math.round(value * 100) / 100;
}
function approvalRoles(value, session) {
  if (!Array.isArray(value) || !value.length || value.length > EDITABLE_ROLES.length || value.some(role => typeof role !== 'string' || !STAFF_ROLES.includes(role)) || new Set(value).size !== value.length) throw fail('invalid_roles', 'Choose the role this person starts with: manager, crew_lead, crew, sales or phone.');
  if (value.includes('owner')) throw fail('owner_role_reserved', 'The owner role belongs only to the configured owner account.', 403);
  if (value.includes('manager') && !isHubOwner(session)) throw fail('owner_role_reserved', 'Only the owner can approve someone as a manager.', 403);
  return EDITABLE_ROLES.filter(role => value.includes(role));
}
// The first-rate plan and the Gusto file key people the same way; a card counts only when its rate is exactly $0.
const zeroRate = card => payAmount(card?.hourlyRate) === 0;

/** Storage: the sealed employee account and profile records, the timecards, the payroll week export records, receipts
 * and one atomic commit (commitVaultDocuments) of all of them with the audit entries. */
export function staffAccessStorage(env, fetcher = firestoreFetch) {
  const documents = dispatchStorage(env, fetcher), accounts = employeeInvitationStore(env);
  async function commit({ account = null, profile = null, timecards = [], fences = [], receipt = null, audits = [], now }) {
    const writes = [];
    if (account) { const sealed = await sealedAccountFields(env, account.account); writes.push({ collection: 'jobs', id: sealed.documentId, revision: account.version, patch: sealed.fields }); }
    if (profile) { const id = profile.documentId || await opaqueId(env, 'profiles', profile.id); writes.push({ collection: 'jobs', id, revision: profile.revision || undefined, patch: await sealedFields(env, 'profiles', id, profile.data, now) }); }
    for (const card of timecards) writes.push({ collection: 'jobs', id: card.documentId, revision: card.revision, patch: await sealedFields(env, 'timeEntries', card.documentId, card.data, now) });
    writes.push(...fences);
    if (receipt) writes.push({ collection: STAFF_ACCESS_RECEIPTS, id: receipt.id, patch: receipt.data });
    for (const audit of audits) writes.push({ collection: audit.collection, id: audit.id, patch: audit.patch });
    try { await commitVaultDocuments(env, writes, fetcher); }
    catch (error) {
      if (error?.code === 'EMPLOYEE_HUB_WRITE_CONFLICT') throw fail('revision_conflict', 'This record changed while saving. Refresh and review the latest before trying again.', 409);
      throw fail('outcome_unknown', 'The save could not be verified. Retry the same request to safely check whether it saved.', 503);
    }
  }
  return {
    configured: () => employeeAccountsConfigured(env),
    readOnly: () => employeeVaultReadOnly(env),
    readAccount: username => accounts.read(username),
    password: value => accounts.password(value),
    profiles: () => readCollectionRecords(env, 'profiles'),
    timecards: () => readCollectionRecords(env, 'timeEntries'),
    readWeek: weekStart => documents.read(PAYROLL_WEEK_EXPORTS, weekStart),
    async readReceipt(id) {
      try { return await documents.read(STAFF_ACCESS_RECEIPTS, id); }
      catch { throw fail('storage_unavailable', 'This request could not be verified. Keep it and retry.', 503); }
    },
    fingerprint: value => vaultDigest(env, 'staff-access:receipt-v1', value),
    commit,
    // A used sign-in reset link sets the password with an audit entry in the same commit (no Hub session exists then).
    saveReset(account, version, at) {
      const audit = auditWrite({ actor: { id: auditId(account.username), kind: 'human', role: null }, via: 'hub', action: 'staff_access.reset_redeemed',
        entity: { collection: 'staff', id: auditEntity(account.username) }, before: { signInResetPending: true }, after: { signInResetPending: false, passwordChanged: true }, visibility: 'business', now: at });
      return commit({ account: { account, version }, audits: [audit], now: at });
    },
  };
}

/** The reset-link store the staff setup page redeems with (staff-invitation-service.js createStaffInvitationService resets). */
export function staffResetStore(env, storage = staffAccessStorage(env)) {
  return { read: username => storage.readAccount(username), password: value => storage.password(value), passwordProblem: employeePasswordProblem, save: (account, version, at) => storage.saveReset(account, version, at) };
}

// revocations(): the Firebase session revocation service (firebase-revocation.js), or null. now() is a Date.
export function createStaffAccessService({ store, env = {}, now = () => new Date(), revocations = () => null }) {
  const enabled = () => staffPasswordResetEnabled(env);
  // A review answer for an approver without pay.manage leaves out the account's pay fields.
  const accountView = (session, account) => { const view = publicEmployeeAccount(account); return seesOthersPay(session, env) ? view : payHidden('accounts', view); };
  function ready(session, message) {
    if (!enabled()) throw fail('not_enabled', 'Staff sign-in resets and password changes are not turned on.', 404);
    if (!session?.user) throw fail('sign_in_required', message, 401);
  }
  const writable = () => { if (store.readOnly()) throw fail('recovery_read_only', 'Employee setup is being verified. Existing records are preserved and cannot be changed yet.', 503); };
  async function receiptFor(requestId, fingerprint) {
    const saved = await store.readReceipt(requestId);
    if (saved && saved.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request id was already used for a different change. Refresh and try again.', 409);
    return saved;
  }
  const receiptWrite = (requestId, action, actor, target, fingerprint, at, result = null) => ({ id: requestId, data: { kind: 'staff_access_receipt_v1', action, actor: personKey(actor), target: personKey(target), fingerprint, createdAt: at, ...(result ? { result } : {}) } });
  async function approvedAccount(username, message = 'That staff member has no approved employee account.') {
    if (isReservedEmployeeUsername(username)) throw fail('configured_account', 'Configured Hub users keep the sign-in set in the Hub configuration. Ask the owner.', 409);
    const saved = await store.readAccount(username);
    if (!saved?.account || saved.account.status !== 'approved' || !same(saved.account.username, username)) throw fail('not_found', message, 404);
    return saved;
  }
  // Firebase data sessions: intent before the save, revoke after it (or drop the intent when the save was refused).
  async function withRevocation(users, at, save) {
    const service = revocations(), intent = await recordStaffFirebaseIntent(service, users, 'account_status', at);
    let result;
    try { result = await save(); }
    catch (error) {
      if (error?.code === 'staff_access_revision_conflict') await settleStaffFirebaseIntent(service, users, intent, now().toISOString());
      else if (error?.code === 'staff_access_outcome_unknown') await revokeStaffFirebaseSessions(service, users, 'account_status', firebaseRevocationTime(now()), intent);
      else await settleStaffFirebaseIntent(service, users, intent, now().toISOString());
      throw error;
    }
    if (result?.revoke === false) { await settleStaffFirebaseIntent(service, users, intent, now().toISOString()); return { ...result, firebaseRevocation: { status: 'not_needed' } }; }
    return { ...result, firebaseRevocation: await revokeStaffFirebaseSessions(service, users, 'account_status', firebaseRevocationTime(now()), intent) };
  }

  // The rate plan for an employee's $0 timecards: grouped by payroll week (Monday, Denver), each at the rate the dated
  // pay schedule gives its work day, with the week's export record. Nothing here is written.
  async function ratePlan(username) {
    const saved = await approvedAccount(username), account = saved.account;
    const person = { key: personKey(account.username), username: account.username, displayName: account.displayName || account.username, source: 'employee_account', accountHourlyRate: account.hourlyRate };
    withProfile(person, await store.profiles());
    if (person.profileNeedsReview) throw fail('profile_ambiguous', 'This employee has a profile saved under an unrecognized id. Ask the owner to review it before applying a rate.', 409);
    const profile = payProfile(person);
    if (!person.record || !storedPayRates(profile.payRates)) throw fail('no_rate', 'Set this person\'s rate in the staff directory with an effective date first. Timecards take the rate in effect on their work day.', 409);
    const weeks = new Map(), skipped = { beforeRate: 0, notHourly: 0, unreadable: 0 };
    for (const row of await store.timecards()) {
      const card = row.data;
      if (!record(card) || !same(card.employee, account.username) || !zeroRate(card)) continue;
      const date = denverWorkDate(card.clockInAt);
      if (!date) { skipped.unreadable += 1; continue; }
      if (card.payType !== undefined && card.payType !== null && card.payType !== '' && card.payType !== 'hourly') { skipped.notHourly += 1; continue; }
      const rate = effectivePayRate(profile, date);
      if (rate.source !== 'pay_rates' || rate.payType !== 'hourly' || !(rate.hourlyRate > 0)) { skipped.beforeRate += 1; continue; }
      const weekStart = timesheetWeekStart(date), week = weeks.get(weekStart) || { weekStart, weekEnd: addDays(weekStart, 6), cards: [] };
      const hours = typeof card.hours === 'number' && Number.isFinite(card.hours) && card.hours >= 0 ? card.hours : null;
      week.cards.push({ id: card.id, documentId: row.documentId, revision: row.updateTime, data: card, date, hours, rate: rate.hourlyRate });
      weeks.set(weekStart, week);
    }
    const list = [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const stored = await Promise.all(list.map(week => store.readWeek(week.weekStart)));
    list.forEach((week, index) => { week.record = stored[index] || null; week.exported = weekExported(stored[index]); week.cards.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id))); });
    const open = list.filter(week => !week.exported);
    const planDigest = await sha256(canonicalJson({ profileRevision: person.revision, weeks: open.map(week => ({ weekStart: week.weekStart, revision: week.record?.revision || '', cards: week.cards.map(card => [card.id, card.revision, card.rate]) })) }));
    return { account, person, weeks: list, open, planDigest, skipped };
  }
  const weekView = week => ({ weekStart: week.weekStart, weekEnd: week.weekEnd, exported: week.exported, ...(week.exported ? { exportedAt: week.record.exportedAt } : {}), timecards: week.cards.length,
    hours: Math.round(week.cards.reduce((sum, card) => sum + (card.hours || 0), 0) * 100) / 100, rates: [...new Set(week.cards.map(card => card.rate))],
    pay: Math.round(week.cards.reduce((sum, card) => sum + (card.hours || 0) * card.rate, 0) * 100) / 100 });

  return {
    /** GET /api/employee-accounts additions for an approver: what this viewer's review dialog asks for. */
    reviewOptions(session) {
      return { setsPay: can(session, 'pay.manage', env), roles: EDITABLE_ROLES.filter(role => role !== 'manager' || isHubOwner(session)), resets: can(session, 'accounts.reset', env) };
    },

    /** Account review: the approver needs accounts.approve; an approval names the starting role, and the owner (pay.manage)
     * also the starting rate, effective the approval day. A manager's approval leaves pay pending for the owner. A manager
     * the owner lets approve reviews pending requests only, and never an account holding the manager role: re-reviewing an
     * approved or rejected account (demoting, deactivating or re-activating it) stays the owner's. approvedAt is stamped
     * on the first approval and kept, so a later re-review never moves the first rate's backdating floor. */
    async review(session, input) {
      ready(session, 'Sign in to review employee accounts.');
      if (!can(session, 'accounts.approve', env)) throw fail('forbidden', 'Only the owner, or a manager the owner allows, can review employee accounts.', 403);
      keysOnly(input, ['action', 'requestId', 'username', 'decision', 'staffRoles', 'hourlyRate', 'payType', 'reason']);
      const requestId = requestIdOf(input), username = usernameOf(input), reason = reasonOf(input), decision = input.decision;
      if (!['approved', 'rejected'].includes(decision)) throw fail('invalid_request', 'Choose approve or reject.');
      const approved = decision === 'approved', setsPay = can(session, 'pay.manage', env), paySent = input.hourlyRate !== undefined || input.payType !== undefined;
      if (!approved && (input.staffRoles !== undefined || paySent)) throw fail('invalid_request', 'A rejection sets no role or pay.');
      if (paySent && !setsPay) throw payRefused('Only the owner sets pay. Approve with a role; the owner sets the starting rate before the first shift.');
      const roles = approved ? approvalRoles(input.staffRoles, session) : null;
      if (approved && setsPay && input.hourlyRate === undefined) throw fail('invalid_pay', 'Enter the starting hourly rate. It takes effect today, the day you approve the account.');
      const rate = approved && setsPay ? startingRate(input.hourlyRate) : null, payType = input.payType === undefined ? 'hourly' : input.payType;
      if (!PAY_TYPES.includes(payType)) throw fail('invalid_pay', 'Choose hourly or salary pay.');
      if (isReservedEmployeeUsername(username)) throw fail('configured_account', 'Business accounts are managed through secure staff configuration.', 409);
      writable();
      const fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(session.user), input }));
      if (await receiptFor(requestId, fingerprint)) {
        const saved = await store.readAccount(username);
        if (saved?.account?.reviewRequestId === requestId) return { ok: true, authority: 'employee_hub', replayed: true, account: accountView(session, saved.account), firebaseRevocation: { status: 'not_needed' } };
        throw fail('changed_since_operation', 'This review was saved and the account has changed since. Refresh to see the latest.', 409);
      }
      const saved = await store.readAccount(username);
      if (!saved?.account || !same(saved.account.username, username)) throw fail('not_found', 'Employee application not found.', 404);
      const date = now(), at = date.toISOString(), today = denverToday(date), account = saved.account, actor = String(session.user);
      const storedRoles = sanitizeStaffRoles(account.staffRoles, { user: account.username, businessAccess: false });
      if (!isHubOwner(session)) {
        if (storedRoles?.includes('manager')) throw fail('owner_role_reserved', 'Only the owner can review a manager\'s account.', 403);
        if (account.status !== 'pending') throw fail('forbidden', 'This account was already reviewed. Only the owner can review it again.', 403);
      }
      const rolesChanged = approved && canonicalJson(storedRoles) !== canonicalJson(roles), statusChanged = account.status !== decision;
      // The first approval day: kept once stamped; an account approved before approvedAt existed keeps its last review time.
      const approvedAt = instant(account.approvedAt) || (account.status === 'approved' && instant(account.reviewedAt)) || (approved ? at : '');
      const next = { ...account, status: decision, sessionVersion: statusChanged || rolesChanged ? crypto.randomUUID() : String(account.sessionVersion || ''), role: namedStaffRole(account), businessAccess: false,
        reviewedAt: at, reviewedBy: text(actor, 60), updatedAt: at, reviewRequestId: requestId, ...(approvedAt ? { approvedAt } : {}),
        ...(approved ? { staffRoles: roles, rolesUpdatedAt: at, rolesUpdatedBy: actor } : {}), ...(rate !== null ? { hourlyRate: rate, payType } : {}) };
      // The profile gets the starting rate on its dated schedule (as set_pay would) and mirrors the roles. The rate takes
      // effect the approval day: today, or for an account a manager approved earlier with pay pending, its first approval
      // day (the first-rate floor), so the $0 shifts worked since can take it through Apply rate.
      const person = { key: personKey(account.username), username: account.username, source: 'employee_account', accountHourlyRate: account.hourlyRate, approvedAt };
      let profile = null, payPending = false, startingRateFrom = '';
      if (approved) {
        withProfile(person, await store.profiles());
        if (rate !== null) {
          if (person.profileNeedsReview) throw fail('profile_ambiguous', 'This employee has a profile saved under an unrecognized id. Review it before approving with a rate.', 409);
          const firstFrom = firstRateFrom(person, today, env);
          startingRateFrom = firstFrom || today;
          let change;
          try { change = payChange(person, { effectiveFrom: startingRateFrom, hourlyRate: rate, payType }, actor, at, today, firstFrom); }
          catch (error) { throw String(error?.code || '').startsWith('staff_directory_') ? fail(error.code.slice('staff_directory_'.length), error.message, error.status) : error; }
          if (change) {
            const { scope, before, after, auditView, ...fields } = change, current = person.record?.data || {};
            profile = { id: current.id || person.key, documentId: person.record?.documentId || '', revision: person.revision, data: { ...current, ...fields, staffRoles: roles, id: current.id || person.key, username: current.username || account.username,
              history: appendHistory(current.history, { action: 'account_approval', scope, actor, at, requestId, reason, changes: { before, after } }), updatedAt: at } };
          }
        } else payPending = !((effectivePayRate(payProfile(person), today).hourlyRate ?? 0) > 0);
      }
      const audit = auditWrite({ actor: { id: auditId(actor), kind: 'human', role: session.role || null }, via: 'hub', action: 'employee_account.review', entity: { collection: 'staff', id: auditEntity(account.username) },
        before: { status: account.status, staffRoles: storedRoles }, after: { status: decision, ...(approved ? { staffRoles: roles, startingRateSet: rate !== null, ...(startingRateFrom ? { startingRateFrom } : {}), payPending } : {}) }, requestId, reason: reason || null, visibility: rate !== null ? 'owner' : 'business', now: at });
      const users = [account.username];
      const result = await withRevocation(users, at, async () => {
        await store.commit({ account: { account: next, version: saved.version }, profile, receipt: receiptWrite(requestId, 'review', actor, account.username, fingerprint, at), audits: [audit], now: at });
        return { revoke: statusChanged || rolesChanged };
      });
      return { ok: true, authority: 'employee_hub', account: accountView(session, next), firebaseRevocation: result.firebaseRevocation, ...(approved ? { payPending, startingRateSet: rate !== null, ...(startingRateFrom ? { startingRateFrom } : {}) } : {}) };
    },

    /** A single-use sign-in reset link, valid 24 hours, for an approved employee account (accounts.reset). It ends the
     * person's Hub and Firebase sessions and locks the old password; the link is returned once, for the manager to copy. */
    async issueReset(session, input) {
      ready(session, 'Sign in to reset a staff sign-in.');
      if (!can(session, 'accounts.reset', env)) throw fail('forbidden', 'Only the owner, or a manager the owner allows, can reset a staff sign-in.', 403);
      keysOnly(input, ['action', 'requestId', 'username', 'expectedUser', 'reason']);
      const requestId = requestIdOf(input), username = usernameOf(input), reason = reasonOf(input);
      expectedUserOf(input, session);
      if (same(username, session.user)) throw fail('own_account', 'Use Change password under My EGC for your own account.');
      writable();
      const fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(session.user), input }));
      // The link is shown once and never stored, so a replay confirms the reset without it.
      if (await receiptFor(requestId, fingerprint)) return { ok: true, authority: 'employee_hub', replayed: true, username, linkShown: false,
        message: 'This reset was already saved and its link was shown when it was issued. If the link was lost, issue a new reset; only the newest link works.' };
      const saved = await approvedAccount(username, 'Only an approved employee account can have its sign-in reset.');
      const account = saved.account, date = now(), at = date.toISOString(), actor = String(session.user);
      const roles = sanitizeStaffRoles(account.staffRoles, { user: account.username, businessAccess: false }) || [];
      if (roles.includes('manager') && !isHubOwner(session)) throw fail('forbidden', 'Only the owner can reset a manager\'s sign-in.', 403);
      const reset = await createStaffReset(account.username, actor, date.getTime());
      const next = { ...account, signInReset: reset.record, sessionVersion: crypto.randomUUID(), updatedAt: at };
      const audit = auditWrite({ actor: { id: auditId(actor), kind: 'human', role: session.role || null }, via: 'hub', action: 'staff_access.reset_signin', entity: { collection: 'staff', id: auditEntity(account.username) },
        before: { signInResetPending: pendingSignInReset(account) }, after: { signInResetPending: true, expiresAt: reset.record.expiresAt, sessionsEnded: true, sent: false }, requestId, reason: reason || null, visibility: 'business', now: at });
      const result = await withRevocation([account.username], at, async () => {
        await store.commit({ account: { account: next, version: saved.version }, receipt: receiptWrite(requestId, 'reset_signin', actor, account.username, fingerprint, at), audits: [audit], now: at });
        return {};
      });
      return { ok: true, authority: 'employee_hub', username: account.username, displayName: account.displayName || account.username, link: `${STAFF_RESET_ORIGIN}/staff-setup#invite=${encodeURIComponent(reset.invite)}`,
        expiresAt: reset.record.expiresAt, linkShown: true, sent: false, sessionsRevoked: true, firebaseRevocation: result.firebaseRevocation };
    },

    /** The signed-in employee's own password (password.change): checked against the current one, saved with the signup
     * PBKDF2, and every other session ends; the handler re-issues this browser's Hub cookie from `profile`. */
    async changePassword(session, input) {
      ready(session, 'Sign in to change your password.');
      if (!can(session, 'password.change', env)) throw fail('forbidden', 'Your password is set in the Hub configuration. Ask the owner to change it.', 403);
      keysOnly(input, ['action', 'requestId', 'currentPassword', 'newPassword', 'confirmPassword']);
      const requestId = requestIdOf(input), { currentPassword, newPassword, confirmPassword } = input;
      if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 256) throw fail('invalid_request', 'Enter your current password.');
      if (typeof newPassword !== 'string' || newPassword !== confirmPassword) throw fail('invalid_password', 'Enter the same new password twice.');
      const problem = employeePasswordProblem(newPassword);
      if (problem) throw fail('invalid_password', problem + '.');
      if (newPassword === currentPassword) throw fail('invalid_password', 'Choose a new password that is different from your current one.');
      writable();
      // Passwords never enter the receipt: the fingerprint is the account and the request only.
      const fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(session.user), input: { action: 'change_password', requestId } }));
      if (await receiptFor(requestId, fingerprint)) throw fail('already_changed', 'Your password was already changed by this request. Sign in again with your new password if you are asked.', 409);
      const saved = await approvedAccount(session.user, 'Your employee account could not be found. Sign in again.');
      if (String(saved.account.sessionVersion || '') !== String(session.sessionVersion || '')) throw fail('account_changed', 'Your sign-in changed since this page opened. Sign in again, then change your password.', 401);
      if (!await employeePasswordMatches(saved.account, currentPassword)) throw fail('password_incorrect', 'Your current password is not correct. Nothing was changed.');
      const date = now(), at = date.toISOString(), credentials = await store.password(newPassword);
      const next = { ...saved.account, ...credentials, sessionVersion: crypto.randomUUID(), passwordChangedAt: at, updatedAt: at };
      const audit = auditWrite({ actor: { id: auditId(session.user), kind: 'human', role: session.role || null }, via: 'hub', action: 'staff_access.change_password', entity: { collection: 'staff', id: auditEntity(saved.account.username) },
        before: null, after: { passwordChanged: true, otherSessionsEnded: true }, requestId, visibility: 'business', now: at });
      const result = await withRevocation([saved.account.username], at, async () => {
        await store.commit({ account: { account: next, version: saved.version }, receipt: receiptWrite(requestId, 'change_password', session.user, saved.account.username, fingerprint, at), audits: [audit], now: at });
        return {};
      });
      return { ok: true, authority: 'employee_hub', passwordChanged: true, otherSessionsEnded: true, firebaseRevocation: result.firebaseRevocation, profile: employeeSessionProfile(next) };
    },

    /** What 'Apply rate to open weeks' would change (owner, pay.manage): the $0 timecards by payroll week, which weeks are
     * exported (never changed), and the planDigest and profile revision an apply must send back. */
    async previewApplyRate(session, input) {
      ready(session, 'Sign in to apply a rate.');
      if (!can(session, 'pay.manage', env)) throw payRefused('Only the owner can apply a rate to timecards.');
      keysOnly(input, ['action', 'username']);
      const plan = await ratePlan(usernameOf(input));
      return { ok: true, authority: 'employee_hub', username: plan.account.username, displayName: plan.person.displayName, expectedRevision: plan.person.revision, planDigest: plan.planDigest,
        weeks: plan.weeks.map(weekView), skipped: plan.skipped, limit: APPLY_RATE_LIMIT, asOf: now().toISOString() };
    },

    /** Sets the scheduled rate on the $0 timecards of the chosen open weeks, in one commit fenced on the profile revision,
     * each timecard's revision and each week's export record, with an audit entry and a receipt. Approvals and hours are
     * kept; each card records the change in its history. Exported weeks are refused. */
    async applyRate(session, input) {
      ready(session, 'Sign in to apply a rate.');
      if (!can(session, 'pay.manage', env)) throw payRefused('Only the owner can apply a rate to timecards.');
      keysOnly(input, ['action', 'requestId', 'username', 'expectedRevision', 'planDigest', 'weeks', 'expectedUser', 'reason']);
      const requestId = requestIdOf(input), username = usernameOf(input), reason = reasonOf(input);
      expectedUserOf(input, session);
      if (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 100 || typeof input.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.planDigest)) throw fail('invalid_request', 'Preview the change again before applying it.');
      if (!Array.isArray(input.weeks) || !input.weeks.length || input.weeks.length > 60 || input.weeks.some(week => typeof week !== 'string' || !DATE.test(week)) || new Set(input.weeks).size !== input.weeks.length) throw fail('invalid_request', 'Choose the weeks to apply the rate to.');
      writable();
      const fingerprint = await store.fingerprint(canonicalJson({ actor: personKey(session.user), input }));
      const receipt = await receiptFor(requestId, fingerprint);
      if (receipt) return { ok: true, authority: 'employee_hub', replayed: true, ...(record(receipt.result) ? receipt.result : {}) };
      const plan = await ratePlan(username);
      if (input.expectedRevision !== plan.person.revision || input.planDigest !== plan.planDigest) throw fail('revision_conflict', 'The pay schedule or these timecards changed since the preview. Preview again before applying.', 409);
      const chosen = input.weeks.map(weekStart => plan.weeks.find(week => week.weekStart === weekStart));
      if (chosen.some(week => !week)) throw fail('revision_conflict', 'A chosen week has no $0 timecards now. Preview again before applying.', 409);
      if (chosen.some(week => week.exported)) throw fail('week_exported', 'Payroll for a chosen week was already exported, so its timecards keep their saved rate.', 409);
      const cards = chosen.flatMap(week => week.cards);
      if (cards.length > APPLY_RATE_LIMIT) throw fail('too_many', `Apply the rate to at most ${APPLY_RATE_LIMIT} timecards at a time. Choose fewer weeks.`);
      const date = now(), at = date.toISOString(), actor = String(session.user);
      const timecards = cards.map(card => {
        const gross = card.hours === null ? null : Math.round(card.hours * card.rate * 100) / 100;
        const history = Array.isArray(card.data.history) ? card.data.history : [];
        return { documentId: card.documentId, revision: card.revision, data: { ...card.data, hourlyRate: card.rate, ...(gross === null ? {} : { grossEstimate: gross }), updatedAt: at, updatedBy: actor,
          history: [...history, { action: 'apply_rate', actor, actorName: session.displayName || actor, at, requestId, ...(reason ? { reason } : {}),
            changes: { hourlyRate: { before: card.data.hourlyRate ?? null, after: card.rate }, ...(gross === null ? {} : { grossEstimate: { before: card.data.grossEstimate ?? null, after: gross } }) } }] } };
      });
      // The profile is fenced (a no-op write on its revision) so the rate applied is the schedule that was previewed, and
      // each week's export record is written with its revision (or created) so an export racing this commit refuses one of them.
      const fences = [{ collection: 'jobs', id: plan.person.record.documentId, revision: plan.person.revision, patch: { vaultId: plan.person.record.documentId } },
        ...chosen.map(week => ({ collection: PAYROLL_WEEK_EXPORTS, id: week.weekStart, ...(week.record ? { revision: week.record.revision } : {}), patch: { weekStart: week.weekStart, weekEnd: week.weekEnd, rateAppliedAt: at, rateAppliedBy: actor, rateAppliedRequestId: requestId } }))];
      const result = { username: plan.account.username, applied: { weeks: chosen.map(week => week.weekStart), timecards: cards.length } };
      const audit = auditWrite({ actor: { id: auditId(actor), kind: 'human', role: session.role || null }, via: 'hub', action: 'staff_access.apply_rate', entity: { collection: 'staff', id: auditEntity(plan.account.username) },
        before: { zeroRateTimecards: cards.length }, after: { weeks: result.applied.weeks, timecards: cards.length }, requestId, reason: reason || null, visibility: 'owner', now: at });
      try {
        await store.commit({ timecards, fences, receipt: receiptWrite(requestId, 'apply_rate', actor, plan.account.username, fingerprint, at, result), audits: [audit], now: at });
      } catch (error) {
        // A lost response or a racing retry of this same request may already have applied it.
        const applied = ['staff_access_revision_conflict', 'staff_access_outcome_unknown'].includes(error?.code) ? await store.readReceipt(requestId).catch(() => null) : null;
        if (applied?.fingerprint === fingerprint) return { ok: true, authority: 'employee_hub', replayed: true, ...(record(applied.result) ? applied.result : {}) };
        throw error;
      }
      return { ok: true, authority: 'employee_hub', ...result };
    },
  };
}
