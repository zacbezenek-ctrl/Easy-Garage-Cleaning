/* PORTAL-INBOX: the Hub's Customer messages list (functions/_lib/customer-message-alerts.js).
   GET                                    open client portal messages, newest first, for anyone who may contact
                                          customers (staff-roles.js can(session, 'customer.send'): business users,
                                          and Sales or Phone with staff-role permissions).
   POST {action:'mark_handled', id}       the same people mark one handled; it leaves the list and the badge.
   Nothing here writes to HighLevel or messages the customer. */
import { getHubSession } from '../_lib/hub-session.js';
import { can } from '../_lib/staff-roles.js';
import { customerMessageAlertStorage, listCustomerMessages, markCustomerMessageHandled } from '../_lib/customer-message-alerts.js';

const MAX_BYTES = 4096;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code, error });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // The SameSite=Strict signed Hub cookie is still required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  if (/^customer_messages_[a-z_]+$/.test(String(error?.code || ''))) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  return failure(503, 'customer_messages_unavailable', 'Customer messages could not be loaded. Retry; nothing was changed.');
}

export function customerMessageHandlers({ session = getHubSession, storage = customerMessageAlertStorage, now = () => new Date() } = {}) {
  async function viewer(request, env) {
    const actor = await session(request, env).catch(() => null);
    if (!actor) return { error: failure(401, 'customer_messages_sign_in_required', 'Sign in to the Employee Hub to see customer messages.') };
    if (!can(actor, 'customer.send', env)) return { error: failure(403, 'customer_messages_forbidden', 'Customer messages are for the office team.') };
    return { actor };
  }
  return {
    async get({ request, env }) {
      const { error } = await viewer(request, env);
      if (error) return error;
      if ([...new URL(request.url).searchParams.keys()].length) return failure(400, 'customer_messages_invalid_query', 'The customer message list takes no query parameters.');
      try {
        const asOf = now().toISOString(), list = await listCustomerMessages(storage(env));
        return reply(200, { ok: true, messages: list.messages, total: list.total, complete: list.complete, asOf });
      } catch (caught) { return errorResponse(caught); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return failure(403, 'customer_messages_origin_forbidden', 'Open the Employee Hub to update customer messages.');
      const { actor, error } = await viewer(request, env);
      if (error) return error;
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'customer_messages_json_required', 'Customer message changes must be JSON.');
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return failure(413, 'customer_messages_request_too_large', 'The request is too large.');
      let input;
      try { input = JSON.parse(raw); } catch { return failure(400, 'customer_messages_json_invalid', 'The request was incomplete. Refresh and try again.'); }
      try { return reply(200, await markCustomerMessageHandled(storage(env), input, actor, now().toISOString())); }
      catch (caught) { return errorResponse(caught); }
    },
  };
}

const handlers = customerMessageHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
