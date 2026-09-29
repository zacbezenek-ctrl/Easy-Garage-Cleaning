/* POST /api/customer-login {identifier}: request a Client Login link. The
   answer is always the same 202 body once the request is well formed, whether
   the phone or email is known, unknown, ambiguous, rate limited or on DND.
   The lookup and send run after the response (waitUntil), and the response is
   padded to a fixed minimum time. Off unless CUSTOMER_LOGIN_ENABLED=true.
   GET is the page's probe: 404 off, 503 when no link could be sent (global
   configuration only, never per identifier) and 405 when ready. The template
   part of that readiness check is cached per isolate for a minute (ten
   seconds after a read error), so probes and posts do not each read
   Firestore. Each accepted request logs one redacted line with its outcome
   code; the "unavailable" line is logged once per reason per minute. */
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { customerIdentityStorage } from '../_lib/customer-identity.js';
import { messagingStorage } from '../_lib/message-send-store.js';
import { createGhlMessenger } from '../_lib/ghl-messenger.js';
import { createApprovedSendService, messagingFlags } from '../_lib/approved-send.js';
import { activeTemplate } from '../_lib/message-template-store.js';
import { purposeKeyRoot } from '../_lib/purpose-keys.js';
import { LOGIN_LINKS, customerLoginEnabled, loginIdentifier, loginLinkOrigin, loginLinkProvider, requestCustomerLoginLink } from '../_lib/customer-magic-link.js';
import { CUSTOMER_SESSIONS } from '../_lib/customer-account-session.js';
import { RATE_LIMITS, cleanupExpiredRecords } from '../_lib/rate-limit.js';

export const CUSTOMER_LOGIN_MESSAGE = "If we find a project for that phone or email, we'll send a sign-in link. It expires in 15 minutes.";
export const MIN_RESPONSE_MS = 700;
export const READINESS_TTL_MS = 60000;
const READ_ERROR_TTL_MS = 10000;
const MAX_BYTES = 2048;
const KEYS = new Set(['identifier', 'botcheck']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LOGGED = ['outcome', 'status', 'reason', 'code', 'bucket'];
// One redacted line per request: internal outcome codes only, never the identifier, address, link or customer.
// A value that is not already a plain code is logged as "redacted".
export const loginLogLine = result => JSON.stringify(Object.fromEntries([['event', 'customer_login'], ...LOGGED.filter(key => result?.[key]).map(key => [key, /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(String(result[key])) ? String(result[key]) : 'redacted'])]));

function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
const unavailable = status => reply(status, { ok: false, code: 'CUSTOMER_LOGIN_UNAVAILABLE', error: 'Client Login is not available right now. Text us for a secure link.' });

// Strict: the exact Origin, JSON and the page's custom header are all required.
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin');
  try { return Boolean(origin) && origin === new URL(request.url).origin && request.headers.get('X-EGC-Portal') === '1'; } catch { return false; }
}

export function customerLoginHandlers({
  storage = env => dispatchStorage(env), identity = env => customerIdentityStorage(env), messaging = env => messagingStorage(env),
  messenger = env => createGhlMessenger({ env }), now = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = bytes => crypto.getRandomValues(bytes), cleanup = cleanupExpiredRecords, log = line => console.log(line),
} = {}) {
  const note = result => { try { log(loginLogLine(result)); } catch { /* Logging never changes the answer. */ } return result; };
  // Per isolate: the last template answer and the last "unavailable" line, each
  // valid from `at` until `until` by the injected clock.
  let template = null, logged = null;
  const fresh = (entry, at) => entry && at >= entry.at && at < entry.until;
  async function templateState(env) {
    const at = now().getTime();
    if (fresh(template, at)) return template.reason;
    let reason, ttl = READINESS_TTL_MS;
    try { reason = await activeTemplate(messaging(env), 'portal_magic_link') ? '' : 'template_unapproved'; }
    catch { reason = 'template_unreadable'; ttl = READ_ERROR_TTL_MS; }
    template = { reason, at, until: at + ttl };
    return reason;
  }
  // Why no link could be sent right now ('' when one could): messaging off, the
  // link keys missing, or the portal_magic_link wording not owner-approved.
  // The same for every identifier, so it reveals nothing.
  async function blocked(env) {
    if (!messagingFlags(env).enabled) return 'messaging_disabled';
    try { purposeKeyRoot(env); } catch { return 'link_keys_unavailable'; }
    return templateState(env);
  }
  // 503 "Text us", logged with the reason (once per reason per minute) so the owner can see why.
  async function notReady(env) {
    const reason = await blocked(env);
    if (!reason) return null;
    const at = now().getTime();
    if (!fresh(logged, at) || logged.reason !== reason) { logged = { reason, at, until: at + READINESS_TTL_MS }; note({ outcome: 'unavailable', reason }); }
    return unavailable(503);
  }
  return {
    async get({ env }) {
      if (!customerLoginEnabled(env)) return unavailable(404);
      const refused = await notReady(env);
      if (refused) return refused;
      return reply(405, { ok: false, code: 'CUSTOMER_LOGIN_METHOD_NOT_ALLOWED', error: 'Use the Client Login page to request a sign-in link.' });
    },
    async post(context) {
      const { request, env } = context;
      if (!customerLoginEnabled(env)) return unavailable(404);
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'CUSTOMER_LOGIN_ORIGIN_FORBIDDEN', error: 'Open the Client Login page on easygaragecleaning.com and try again.' });
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'CUSTOMER_LOGIN_JSON_REQUIRED', error: 'Sign-in requests must be JSON.' });
      if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413, { ok: false, code: 'CUSTOMER_LOGIN_REQUEST_TOO_LARGE', error: 'The sign-in request is too large.' });
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return reply(413, { ok: false, code: 'CUSTOMER_LOGIN_REQUEST_TOO_LARGE', error: 'The sign-in request is too large.' });
      let input;
      try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'CUSTOMER_LOGIN_JSON_INVALID', error: 'The sign-in request was incomplete. Refresh and try again.' }); }
      if (!object(input) || Object.keys(input).some(key => !KEYS.has(key)) || (input.botcheck !== undefined && typeof input.botcheck !== 'string')) return reply(400, { ok: false, code: 'CUSTOMER_LOGIN_REQUEST_INVALID', error: 'The sign-in request was incomplete. Refresh and try again.' });
      // Format only: says nothing about whether the phone or email is on file.
      if (!loginIdentifier(input.identifier)) return reply(400, { ok: false, code: 'CUSTOMER_LOGIN_IDENTIFIER_INVALID', error: 'Enter the mobile number or email address you use with Easy Garage Cleaning.' });
      const refused = await notReady(env);
      if (refused) return refused;
      const started = now().getTime();
      // A filled honeypot is answered like any other request and never looked up.
      const work = (input.botcheck ? Promise.resolve({ outcome: 'honeypot' }) : (async () => {
        const store = storage(env), clock = () => now().toISOString();
        const service = createApprovedSendService({ store: messaging(env), messenger: messenger(env), clock: now, env, links: { loginLink: loginLinkProvider(store, env, { now: clock, random, origin: loginLinkOrigin(request.url) }) } });
        const result = await requestCustomerLoginLink({ store, identity: identity(env), env, service, now: clock, random }, { identifier: input.identifier, ip: request.headers.get('CF-Connecting-IP') || '' });
        // Bounded, occasional cleanup of expired counters, links and sessions.
        if (random(new Uint8Array(1))[0] < 16) for (const collection of [RATE_LIMITS, LOGIN_LINKS, CUSTOMER_SESSIONS]) await cleanup(env, collection, clock());
        return result;
      })().catch(error => ({ outcome: 'error', code: String(error?.code || 'unknown').slice(0, 80) }))).then(note);
      // Called on the context so the runtime keeps its binding.
      if (typeof context.waitUntil === 'function') context.waitUntil(work); else await work;
      const elapsed = now().getTime() - started;
      if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed);
      return reply(202, { ok: true, message: CUSTOMER_LOGIN_MESSAGE });
    },
  };
}

const handlers = customerLoginHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
