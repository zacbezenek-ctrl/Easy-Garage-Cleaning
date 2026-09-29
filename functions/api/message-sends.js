/**
 * GET /api/message-sends — owners/managers list approved sends whose outcome
 * is unknown ('uncertain', or 'sending' left by a delivery that never saved),
 * plus lateResults: sends HighLevel answered after a person reconciled them
 * (last 7 days), shown beside what the person recorded.
 * POST /api/message-sends {action:'reconcile', requestId, ledgerId,
 * expectedRevision, outcome:'delivered'|'not_delivered', note} records what a
 * person confirmed in HighLevel. Nothing is ever sent from here.
 */
import { getHubSession } from '../_lib/hub-session.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { messageReconcileStorage, reconcileMessageSend, unsettledMessageSends } from '../_lib/message-reconcile.js';

const MAX_BYTES = 8192;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // The SameSite=Strict signed Hub cookie is still required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function failure(error) {
  const code = String(error?.code || '');
  if (/^messaging_[a-z_]+$/.test(code)) return reply(error.status || 503, { ok: false, code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (code === 'dispatch_sign_in_required') return reply(401, { ok: false, code: 'messaging_sign_in_required', error: 'Sign in to the Employee Hub to review messages.' });
  if (code === 'dispatch_forbidden') return reply(403, { ok: false, code: 'messaging_forbidden', error: 'Only an operations manager or owner can reconcile messages.' });
  return reply(503, { ok: false, code: 'messaging_unavailable', error: 'Message records could not be verified. Retry the same request; nothing was sent.' });
}

export function messageSendHandlers({ session = getHubSession, storage = messageReconcileStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        requireDispatcher(actor, env);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'messaging_invalid_query', error: 'The message list takes no query parameters.' });
        return reply(200, await unsettledMessageSends(storage(env), actor, now().toISOString()));
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'messaging_origin_forbidden', error: 'Open the Employee Hub to reconcile messages.' });
      try {
        const actor = await session(request, env);
        requireDispatcher(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'messaging_json_required', error: 'Message changes must be JSON.' });
        if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The message request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The message request is too large.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'messaging_json_invalid', error: 'The message request was incomplete. Refresh and try again.' }); }
        return reply(200, await reconcileMessageSend(storage(env), actor, input, now().toISOString()));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = messageSendHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
