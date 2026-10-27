import { getHubSession } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { employeeVaultReadOnly, employeeVaultSecret } from '../_lib/employee-vault-key.js';
import { crewChatPushEnabled, removeCrewPushSubscription, saveCrewPushSubscription } from '../_lib/crew-push.js';
import { vapidKeys } from '../_lib/web-push.js';

// CREW-PUSH (functions/_lib/crew-push.js): phone alerts for crew chat while the Hub is closed.
// GET    /api/hub-push  whether alerts are on, and the VAPID public key the browser subscribes with (no account data).
// POST   /api/hub-push  {subscription}  saves this browser's subscription for the signed-in person.
// DELETE /api/hub-push  {endpoint}      removes it (sign-out, alerts turned off); only the person's own.
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

async function body(request) {
  const raw = await request.text();
  if (raw.length > 4096) return null;
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

export function hubPushHandlers({ now = () => new Date() } = {}) {
  async function gate(request, env) {
    if (!allowed(request)) return { error: reply(403, { ok: false, error: 'Forbidden origin' }) };
    const session = await getHubSession(request, env);
    if (!session) return { error: reply(401, { ok: false, error: 'Sign in required' }) };
    if (!crewChatPushEnabled(env)) return { error: reply(404, { ok: false, code: 'CREW_PUSH_OFF', error: 'Phone alerts are not turned on' }) };
    if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) return { error: reply(503, { ok: false, error: 'Employee Hub storage is not configured' }) };
    return { session };
  }

  return {
    get({ env }) {
      const enabled = crewChatPushEnabled(env);
      return reply(200, { ok: true, enabled, ...(enabled ? { publicKey: vapidKeys(env).publicKey } : {}) });
    },
    async post({ request, env }) {
      const { session, error } = await gate(request, env);
      if (error) return error;
      if (employeeVaultReadOnly(env)) return reply(503, { ok: false, code: 'EMPLOYEE_HUB_RECOVERY_READ_ONLY', error: 'Employee setup is being verified. Try turning on alerts later.' });
      const input = await body(request);
      if (!input) return reply(400, { ok: false, error: 'Invalid alert subscription' });
      try {
        await saveCrewPushSubscription(env, session.user, input.subscription, { now: now() });
        return reply(200, { ok: true });
      } catch (failure) {
        return reply(failure.status === 400 ? 400 : 502, { ok: false, error: failure.status === 400 ? failure.message : 'Alerts could not be turned on. Try again.' });
      }
    },
    async delete({ request, env }) {
      const { session, error } = await gate(request, env);
      if (error) return error;
      const input = await body(request);
      if (!input || typeof input.endpoint !== 'string') return reply(400, { ok: false, error: 'Invalid alert subscription' });
      try {
        return reply(200, { ok: true, removed: await removeCrewPushSubscription(env, session.user, input.endpoint) });
      } catch {
        return reply(502, { ok: false, error: 'Alerts could not be turned off on the server. They stop on this device anyway.' });
      }
    },
  };
}

const handlers = hubPushHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
export const onRequestDelete = handlers.delete;
