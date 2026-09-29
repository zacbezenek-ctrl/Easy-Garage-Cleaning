import { getHubSession, readCookie } from './hub-session.js';
import { safeStaffNext, staffGatedPath, staffPathForms } from '../../staff-paths.js';

// "on" or "true" (any case, spaces trimmed) gates the staff pages and scripts in staff-paths.js; anything else keeps
// today's public static files, and /api/integration-status names a value that is neither on nor off (OPS-08).
const GATE_ON = new Set(['on', 'true']), GATE_OFF = new Set(['', 'off', 'false']);
const gateValue = env => typeof env?.EGC_STAFF_PAGE_GATE === 'string' ? env.EGC_STAFF_PAGE_GATE.trim().toLowerCase() : '';
export const staffPageGateEnabled = env => GATE_ON.has(gateValue(env));

// {enabled, recognized}: recognized is false for a set value that means neither on nor off (the gate stays off).
export function staffPageGateState(env) {
  const value = gateValue(env);
  return { enabled: GATE_ON.has(value), recognized: GATE_ON.has(value) || GATE_OFF.has(value) };
}

function htmlNavigation(request) {
  return request.headers.get('Sec-Fetch-Mode') === 'navigate' || /\btext\/html\b/i.test(request.headers.get('Accept') || '');
}

// Where a signed-out navigation goes: the crew sign-in for crew tools, /staff-login for everything else, carrying the
// refused page only when it is itself a safe `next`.
export function staffSignInLocation(url) {
  const target = safeStaffNext(url.pathname + url.search) || safeStaffNext(url.pathname);
  const crew = (staffPathForms(url.pathname) || []).some(form => /^\/crew\//i.test(form));
  const page = crew ? '/crew/' : '/staff-login';
  return target ? `${page}?next=${encodeURIComponent(target)}` : page;
}

function refusal(request, url) {
  if ((request.method === 'GET' || request.method === 'HEAD') && htmlNavigation(request)) {
    return new Response(null, { status: 302, headers: { Location: staffSignInLocation(url) } });
  }
  return new Response('Sign in required.\n', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

const MEMO_MS = 45000, MEMO_MAX = 500;

async function memoKey(request) {
  const token = readCookie(request);
  if (!token) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// An employee-account check reads storage, and one Hub page loads about 15 gated files at once, so a script or stylesheet
// may reuse that account's full check for 45 s (per isolate, so one deployment's settings; keyed by the cookie's hash;
// never past the session's expiry). Page loads always run the full check, which refreshes or drops the entry.
function remember(memo, key, viewer, at) {
  if (!key) return;
  memo.delete(key);
  if (viewer?.source !== 'employee-account') return;
  for (const [entry, saved] of memo) if (saved.until <= at || memo.size >= MEMO_MAX) memo.delete(entry); else break;
  memo.set(key, { until: Math.min(at + MEMO_MS, Number(viewer.expiresAt) || at) });
}

// Resolves to null (not a gated request: the middleware carries on exactly as before) or {refusal} where refusal is the
// redirect/401 to send instead of the static file, or null when the Hub session is valid.
export function staffPageGate({ session = getHubSession, now = () => Date.now(), memo = new Map() } = {}) {
  return async function gate(request, env) {
    if (!staffPageGateEnabled(env)) return null;
    const url = new URL(request.url);
    if (!staffGatedPath(url.pathname)) return null;
    const page = htmlNavigation(request), key = await memoKey(request).catch(() => ''), at = now();
    if (!page && key && memo.get(key)?.until > at) return { refusal: null };
    let viewer = null;
    try { viewer = await session(request, env); } catch { viewer = null; }
    remember(memo, key, viewer, at);
    return { refusal: viewer ? null : refusal(request, url) };
  };
}

// Allowed or refused, a gated response is per-viewer: never stored by a browser, proxy or the edge, and never indexed.
export function privateStaffResponse(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  const vary = response.headers.get('Vary');
  if (!vary) response.headers.set('Vary', 'Cookie');
  else if (!vary.split(',').some(name => name.trim().toLowerCase() === 'cookie')) response.headers.set('Vary', `${vary}, Cookie`);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const gateStaffPage = staffPageGate();
