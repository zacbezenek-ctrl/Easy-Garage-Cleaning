import { getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';
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
// server account is absent); now() is the review clock.
export function employeeAccountsHandlers({ session = getHubSession, revocations = firebaseRevocations, now = () => new Date() } = {}) {
  const deps = { readSession: session, revocations, now };
  return { get: context => accountsGet(context, deps), post: context => accountsPost(context, deps) };
}

async function accountsGet({ request, env }, { readSession }) {
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

async function accountsPost({ request, env }, { readSession, revocations, now }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, code: 'EMPLOYEE_ACCOUNTS_NOT_CONFIGURED', error: 'Employee accounts are unavailable while Zac completes secure Hub setup. This request was not saved; keep your details and retry after setup.' });
  const raw = await request.text();
  if (raw.length > 16 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'Enter your employee account details' });
  const action = String(body.action || 'register');

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
