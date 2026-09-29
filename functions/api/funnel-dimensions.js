import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { bookingDimensionPrefill, ghlServiceLineSuggestion } from '../_lib/funnel-dimensions.js';

// FUN-29: the service-line and funnel-path pre-fill for the Dispatch create form.
// Read-only; the create itself re-derives both on the server (schedule.create).
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function errorResponse(error) {
  if (/^(funnel_dimensions_|dispatch_)/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  return reply(503, { ok: false, code: 'funnel_dimensions_unavailable', error: 'The service line suggestion could not be loaded. Choose the service line and path yourself.' });
}

export function funnelDimensionsHandlers({ session = getHubSession, storage = dispatchStorage, ghl = ghlServiceLineSuggestion, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireDispatcher(actor);
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (new Set(keys).size !== keys.length) return reply(400, { ok: false, code: 'funnel_dimensions_query_invalid', error: 'Each pre-fill field can be sent once.' });
        return reply(200, await bookingDimensionPrefill(storage(env), Object.fromEntries(params.entries()), { ghl: contactId => ghl(env, contactId), now: now().toISOString() }));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = funnelDimensionsHandlers();
export const onRequestGet = handlers.get;
