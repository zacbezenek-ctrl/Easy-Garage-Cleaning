import { getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';
import {
  createEmployeeApplication,
  employeeAccountsConfigured,
  listEmployeeApplications,
  normalizeEmployeeUsername,
  reviewEmployeeApplication,
} from '../_lib/employee-accounts.js';

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

const isOwner = session => hasBusinessAccess(session) && normalizeEmployeeUsername(session?.user) === 'zacb';

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!isOwner(session)) return reply(403, { ok: false, error: 'Only Zac can approve employee accounts' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, error: 'Employee account signup is not configured' });
  try {
    return reply(200, { ok: true, accounts: await listEmployeeApplications(env) });
  } catch (error) {
    return reply(502, { ok: false, error: String(error.message || 'Employee applications could not be loaded') });
  }
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  if (!employeeAccountsConfigured(env)) return reply(503, { ok: false, error: 'Employee account signup is not configured' });
  const raw = await request.text();
  if (raw.length > 16 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const action = String(body.action || 'register');

  if (action === 'register') {
    if (body.company) return reply(201, { ok: true, status: 'pending' });
    if (body.acknowledged !== true) return reply(400, { ok: false, error: 'Confirm that this is your employee account request' });
    const usernameKey = normalizeEmployeeUsername(body.username);
    const reserved = listHubUserProfiles(env).some(profile => normalizeEmployeeUsername(profile.user) === usernameKey);
    if (reserved) return reply(409, { ok: false, error: 'That username is already registered' });
    try {
      const account = await createEmployeeApplication(env, body);
      return reply(201, { ok: true, status: account.status, displayName: account.displayName });
    } catch (error) {
      const message = String(error.message || 'Employee account request could not be submitted');
      return reply(/already registered/i.test(message) ? 409 : 400, { ok: false, error: message });
    }
  }

  if (action === 'review') {
    const session = await getHubSession(request, env);
    if (!session) return reply(401, { ok: false, error: 'Sign in required' });
    if (!isOwner(session)) return reply(403, { ok: false, error: 'Only Zac can approve employee accounts' });
    try {
      const account = await reviewEmployeeApplication(
        env,
        String(body.username || ''),
        String(body.decision || ''),
        session.user,
      );
      return reply(200, { ok: true, account });
    } catch (error) {
      return reply(400, { ok: false, error: String(error.message || 'Employee application could not be reviewed') });
    }
  }

  return reply(400, { ok: false, error: 'Unsupported employee account action' });
}

export async function onRequestOptions({ request }) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  } });
}
