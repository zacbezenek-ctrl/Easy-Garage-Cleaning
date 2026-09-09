import { getHubSession, hasBusinessAccess, readCookie } from '../_lib/hub-session.js';
import { gustoConfiguration, gustoAuthorizationUrl, connectGustoAuthorization } from '../_lib/gusto-client.js';
import { readGustoRecord, writeGustoRecord } from '../_lib/gusto-store.js';

const COOKIE = 'egc_gusto_oauth';
const TTL = 10 * 60 * 1000;
const SAFE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const COOKIE_OPTIONS = 'Path=/api/gusto-auth; HttpOnly; Secure; SameSite=Lax';
function errorResponse(message, status) { return Response.json({ error: message }, { status, headers: SAFE }); }
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return (!origin || origin === new URL(request.url).origin) && !['cross-site'].includes(request.headers.get('Sec-Fetch-Site'));
}
function isOwner(session) { return session?.user?.toLowerCase() === 'zacb' && session.role === 'owner' && hasBusinessAccess(session); }
function random() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function sessionHash(request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`egc:gusto:session:v1\n${readCookie(request)}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function redirect(status) {
  return new Response(null, { status: 303, headers: { ...SAFE, Location: `/employee?view=timesheets&gusto=${status}`, 'Set-Cookie': `${COOKIE}=; ${COOKIE_OPTIONS}; Max-Age=0` } });
}
function callbackRelay(code, state, oauthError) {
  // The Hub session uses SameSite=Strict. An external OAuth redirect cannot send
  // that cookie; this same-origin form establishes a document before its POST.
  const nonce = random();
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connecting Gusto</title><body><p>Completing your Gusto connection…</p><form method="post" action="/api/gusto-auth"><input type="hidden" name="code" value="${escape(code)}"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="error" value="${oauthError ? 'denied' : ''}"><noscript><button type="submit">Complete connection</button></noscript></form><script nonce="${nonce}">document.querySelector('form').submit()</script></body></html>`, { headers: { ...SAFE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` } });
}
async function finish(request, env, parameters) {
  if (!sameOrigin(request)) return errorResponse('Open Gusto setup from the EGC Hub.', 403);
  const session = await getHubSession(request, env);
  if (!isOwner(session)) return errorResponse('Sign in as the EGC owner to connect Gusto.', session ? 403 : 401);
  const state = parameters.get('state');
  if (!/^[a-f0-9]{64}$/.test(state || '') || state !== readCookie(request, COOKIE)) return redirect('invalid-state');
  try {
    const ledger = await readGustoRecord(env, `oauth-state:${state}`);
    if (!ledger.data || ledger.data.used || ledger.data.expiresAt <= Date.now() || ledger.data.user !== session.user || ledger.data.sessionHash !== await sessionHash(request)) return redirect('invalid-state');
    // Consume before exchanging: both authorization code and state are one-use.
    await writeGustoRecord(env, `oauth-state:${state}`, { ...ledger.data, used: true }, ledger);
    if (parameters.get('error')) return redirect('cancelled');
    const code = parameters.get('code');
    if (!code || code.length > 4096) return redirect('failed');
    await connectGustoAuthorization(env, code);
    return redirect('connected');
  } catch (error) {
    return redirect(error?.code === 'GUSTO_COMPANY_MISMATCH' ? 'wrong-company' : error?.code === 'GUSTO_WRITE_CONFLICT' ? 'invalid-state' : 'failed');
  }
}

export async function onRequestGet({ request, env }) {
  if (!gustoConfiguration(env).configured) return errorResponse(gustoConfiguration(env).reason, 503);
  const url = new URL(request.url);
  if (url.origin + url.pathname !== env.GUSTO_REDIRECT_URI) return errorResponse('Use the configured EGC Gusto connection address.', 400);
  if (url.searchParams.has('code') || url.searchParams.has('error') || url.searchParams.has('state')) {
    const state = url.searchParams.get('state');
    if (!/^[a-f0-9]{64}$/.test(state || '') || state !== readCookie(request, COOKIE)) return redirect('invalid-state');
    // Always relay, including when the browser happens to send a Strict cookie.
    return callbackRelay(url.searchParams.get('code')?.slice(0, 4097), state, Boolean(url.searchParams.get('error')));
  }
  if (!sameOrigin(request)) return errorResponse('Open Gusto setup from the EGC Hub.', 403);
  const session = await getHubSession(request, env);
  if (!isOwner(session)) return errorResponse('Sign in as the EGC owner to connect Gusto.', session ? 403 : 401);
  try {
    // Verify the existing encrypted tokens before starting a reconnect.
    await readGustoRecord(env, 'oauth-tokens');
    const state = random();
    await writeGustoRecord(env, `oauth-state:${state}`, { user: session.user, sessionHash: await sessionHash(request), expiresAt: Date.now() + TTL, used: false }, null);
    return new Response(null, { status: 302, headers: { ...SAFE, Location: gustoAuthorizationUrl(env, state), 'Set-Cookie': `${COOKIE}=${state}; ${COOKIE_OPTIONS}; Max-Age=${TTL / 1000}` } });
  } catch { return errorResponse('Gusto setup could not access secure storage. Check the saved configuration and try again.', 503); }
}

export async function onRequestPost({ request, env }) {
  if (!gustoConfiguration(env).configured) return errorResponse(gustoConfiguration(env).reason, 503);
  const url = new URL(request.url);
  if (url.origin + url.pathname !== env.GUSTO_REDIRECT_URI || !sameOrigin(request)) return errorResponse('Open Gusto setup from the EGC Hub.', 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return errorResponse('Invalid Gusto connection request.', 400);
  const body = await request.text();
  if (body.length > 8192) return errorResponse('Invalid Gusto connection request.', 400);
  return finish(request, env, new URLSearchParams(body));
}
