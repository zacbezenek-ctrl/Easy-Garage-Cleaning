import { createHubSessionCookie, getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';
import { OWNER_USERNAME } from '../_lib/business-users.js';
import {
  createEmployeeApplication,
  employeeAccountsConfigured,
  listEmployeeApplications,
  normalizeEmployeeUsername,
  isReservedEmployeeUsername,
  reviewEmployeeApplicationChange,
} from '../_lib/employee-accounts.js';
import {
  firebaseRevocations,
  firebaseRevocationTime,
  recordStaffFirebaseIntent,
  revokeStaffFirebaseSessions,
  settleStaffFirebaseIntent,
} from '../_lib/firebase-revocation.js';
import { can, staffPasswordResetEnabled } from '../_lib/staff-roles.js';
import { createStaffAccessService, staffAccessStorage } from '../_lib/staff-access.js';
import { payHidden, seesOthersPay } from '../_lib/pay-visibility.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

const isOwner = session => hasBusinessAccess(session) && normalizeEmployeeUsername(session?.user) === OWNER_USERNAME;

function accountFailure(error, fallbackStatus, fallbackMessage) {
  if (error?.code?.startsWith('EMPLOYEE_ACCOUNT')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  if (error?.code === 'HUB_AUTH_CONFIGURATION') return reply(503, { ok: false, code: error.code, error: error.message });
  if (/already registered/i.test(error?.message || '')) return reply(409, { ok: false, error: 'That username is already registered' });
  return reply(fallbackStatus, { ok: false, error: fallbackMessage });
}

// revocations(env) is the Firebase session revocation service (null when the
// server account is absent); now() is the review clock; storage(env) is the
// STAFF-ACCESS store (staff-access.js).
export function employeeAccountsHandlers({ session = getHubSession, revocations = firebaseRevocations, now = () => new Date(), storage = staffAccessStorage } = {}) {
  const deps = { readSession: session, revocations, now, access: env => createStaffAccessService({ store: storage(env), env, now, revocations: () => revocations(env) }) };
  return { get: context => accountsGet(context, deps), post: context => accountsPost(context, deps) };
}

// STAFF-ACCESS (EGC_STAFF_PASSWORD_RESET on): the approver check is the accounts.approve capability, reviews name a role
// (and, from the owner, a starting rate), and reset_signin and change_password join review. Off: everything below the
// flag checks answers exactly as before.
const ACCESS_ACTIONS = new Set(['review', 'reset_signin', 'change_password']);
function accessFailure(error) {
  if (/^staff_access_[a-z_]+$/.test(error?.code || '') || error?.code === 'pay_owner_only') return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (/^EMPLOYEE_ACCOUNT_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  return reply(503, { ok: false, code: 'staff_access_unavailable', error: 'The change could not be verified. Keep it and retry the same request; do not make it again.' });
}

async function accessGet(request, env, { readSession, access }) {
  const session = await readSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!can(session, 'accounts.approve', env)) return reply(403, { ok: false, code: 'staff_access_forbidden', error: 'Only the owner, or a manager the owner allows, can review employee accounts.' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, code: 'EMPLOYEE_ACCOUNTS_NOT_CONFIGURED', error: 'Employee accounts are unavailable while Zac completes secure Hub setup. Existing applications are preserved.' });
  try {
    // An approver without pay.manage (a granted manager) never gets the accounts' pay fields.
    const accounts = await listEmployeeApplications(env);
    return reply(200, { ok: true, accounts: seesOthersPay(session, env) ? accounts : accounts.map(account => payHidden('accounts', account)), staffAccess: access(env).reviewOptions(session) });
  } catch (error) {
    return accountFailure(error, 502, 'Employee applications could not be loaded. Try again later.');
  }
}

async function accessPost(request, env, body, { readSession, access }) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'staff_access_json_required', error: 'Send this change as JSON.' });
  const session = await readSession(request, env);
  if (!session) return reply(401, { ok: false, code: 'staff_access_sign_in_required', error: 'Sign in required' });
  try {
    const service = access(env);
    if (body.action === 'review') return reply(200, await service.review(session, body));
    if (body.action === 'reset_signin') return reply(200, await service.issueReset(session, body));
    const { profile, ...result } = await service.changePassword(session, body);
    // This browser keeps its sign-in with the new session version; every other session has ended.
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': await createHubSessionCookie(env, profile.user, profile) } });
  } catch (error) {
    return accessFailure(error);
  }
}

async function accountsGet({ request, env }, deps) {
  if (staffPasswordResetEnabled(env)) return accessGet(request, env, deps);
  const { readSession } = deps;
  const session = await readSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!isOwner(session)) return reply(403, { ok: false, error: 'Only Zac can approve employee accounts' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, code: 'EMPLOYEE_ACCOUNTS_NOT_CONFIGURED', error: 'Employee accounts are unavailable while Zac completes secure Hub setup. Existing applications are preserved.' });
  try {
    return reply(200, { ok: true, accounts: await listEmployeeApplications(env) });
  } catch (error) {
    return accountFailure(error, 502, 'Employee applications could not be loaded. Try again later.');
  }
}

async function accountsPost({ request, env }, deps) {
  const { readSession, revocations, now } = deps;
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, code: 'EMPLOYEE_ACCOUNTS_NOT_CONFIGURED', error: 'Employee accounts are unavailable while Zac completes secure Hub setup. This request was not saved; keep your details and retry after setup.' });
  const raw = await request.text();
  if (raw.length > 16 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'Enter your employee account details' });
  const action = String(body.action || 'register');
  if (staffPasswordResetEnabled(env) && ACCESS_ACTIONS.has(action)) return accessPost(request, env, body, deps);

  if (action === 'register') {
    if (body.company) return reply(201, { ok: true, status: 'pending' });
    if (body.acknowledged !== true) return reply(400, { ok: false, error: 'Confirm that this is your employee account request' });
    const usernameKey = normalizeEmployeeUsername(body.username);
    try {
      const reserved = isReservedEmployeeUsername(usernameKey) || listHubUserProfiles(env).some(profile => normalizeEmployeeUsername(profile.user) === usernameKey);
      if (reserved) return reply(409, { ok: false, error: 'That username is already registered' });
      const account = await createEmployeeApplication(env, body);
      return reply(201, { ok: true, status: account.status, displayName: account.displayName });
    } catch (error) {
      const validation = /^(Enter |Username must |Password must )/.test(error?.message || '');
      return accountFailure(error, validation ? 400 : 502, validation ? error.message : 'Employee account request could not be submitted. Try again later.');
    }
  }

  if (action === 'review') {
    const session = await readSession(request, env);
    if (!session) return reply(401, { ok: false, error: 'Sign in required' });
    if (!isOwner(session)) return reply(403, { ok: false, error: 'Only Zac can approve employee accounts' });
    const at = now().toISOString(), decision = String(body.decision || ''), username = normalizeEmployeeUsername(body.username);
    const service = revocations(env);
    // Intent first, so a change that lands after this request stops is still
    // revoked. The revocation time is read after the review is saved (rounded
    // past its second): sessions minted before the save end with it.
    const target = username && ['approved', 'rejected'].includes(decision) && !isReservedEmployeeUsername(username) ? [username] : [];
    const intent = target.length ? await recordStaffFirebaseIntent(service, target, 'account_status', at) : '';
    let review;
    try {
      review = await reviewEmployeeApplicationChange(
        env,
        String(body.username || ''),
        decision,
        session.user,
        at,
      );
    } catch (error) {
      const validation = /^(Choose approve|Employee application not found|Business accounts are managed)/.test(error?.message || '');
      // A refusal changed nothing; any other failure may have saved the change.
      if (validation) await settleStaffFirebaseIntent(service, target, intent, now().toISOString());
      else if (target.length) await revokeStaffFirebaseSessions(service, target, 'account_status', firebaseRevocationTime(now()), intent);
      return accountFailure(error, validation ? 400 : 502, validation ? error.message : 'Employee application could not be reviewed. Try again later.');
    }
    // The saved review already ended Hub sessions; a Firebase failure is
    // reported and queued, never turned into a failed review.
    let firebaseRevocation = { status: 'not_needed' };
    if (review.accessChanged) firebaseRevocation = await revokeStaffFirebaseSessions(service, [review.account.username], 'account_status', firebaseRevocationTime(now()), intent);
    else await settleStaffFirebaseIntent(service, target, intent, now().toISOString());
    return reply(200, { ok: true, account: review.account, firebaseRevocation });
  }

  return reply(400, { ok: false, error: 'Unsupported employee account action' });
}

const handlers = employeeAccountsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;

export async function onRequestOptions({ request }) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  } });
}
