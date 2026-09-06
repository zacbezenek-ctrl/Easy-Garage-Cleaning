import {
  clearHubSessionCookie,
  authenticateHubCredential,
  createHubSessionCookie,
  getHubSession,
  hubAuthConfigured,
} from '../_lib/hub-session.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

function reply(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function allowed(request) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  return session ? reply(200, { ok: true, ...session }) : reply(401, { ok: false, error: 'Sign in required' });
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  if (!hubAuthConfigured(env)) return reply(503, { ok: false, code: 'HUB_AUTH_CONFIGURATION', error: 'Employee sign-in is unavailable while Zac completes secure Hub setup. Existing account requests are saved; you do not need to register again.' });
  const raw = await request.text();
  if (raw.length > 8 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'Enter your username and password' });
  const username = String(body.username || '').trim();
  if (!username || username.length > 80 || typeof body.password !== 'string' || !body.password) return reply(400, { ok: false, error: 'Enter your username and password' });
  let profile;
  try {
    profile = await authenticateHubCredential(env, username, body.password);
  } catch (error) {
    const known = /^EMPLOYEE_ACCOUNT|^HUB_AUTH_CONFIGURATION$/.test(error?.code || '');
    return reply(known ? (error.status || 503) : 502, {
      ok: false,
      code: known ? error.code : 'HUB_AUTH_UNAVAILABLE',
      error: known ? error.message : 'Sign-in is temporarily unavailable. Try again later.',
    });
  }
  if (!profile) {
    return reply(401, { ok: false, error: 'Incorrect username or password' });
  }
  const cookie = await createHubSessionCookie(env, profile.user, profile);
  return reply(200, { ok: true, ...profile }, { 'Set-Cookie': cookie });
}

export async function onRequestDelete({ request }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  return reply(200, { ok: true }, { 'Set-Cookie': clearHubSessionCookie() });
}

export async function onRequestOptions({ request }) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  } });
}
