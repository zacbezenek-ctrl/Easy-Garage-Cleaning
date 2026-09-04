import {
  clearHubSessionCookie,
  authenticateHubCredential,
  createHubSessionCookie,
  getHubSession,
  hubAuthConfigured,
} from '../_lib/hub-session.js';

const HOST = /(^|\.)easygaragecleaning\.com$|\.pages\.dev$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;

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
  if (!hubAuthConfigured(env)) return reply(503, { ok: false, error: 'Hub authentication is not configured' });
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const profile = await authenticateHubCredential(env, username, body.password);
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
