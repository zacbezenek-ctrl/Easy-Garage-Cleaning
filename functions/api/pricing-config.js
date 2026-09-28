import { getHubSession, isHubOwner } from '../_lib/hub-session.js';
import { can } from '../_lib/staff-roles.js';
import { PRICING_PARTS, pricingConfig, walkthroughServiceItems } from '../_lib/pricing-config.js';

// Internal price tables for the signed-in role. Walkthrough and phone-quote tables go
// to staff who author quotes; the labor baseline, wages and targets only to the owner.
// Plain crew get nothing. GET ?parts=walkthrough,phone,owner (default: every permitted part).
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code: `pricing_config_${code}`, error });

export function pricingConfigHandlers({ session = getHubSession, catalog = walkthroughServiceItems } = {}) {
  return {
    async get({ request, env }) {
      const actor = await session(request, env).catch(() => null);
      if (!actor?.user) return failure(401, 'sign_in_required', 'Sign in to load prices.');
      const params = new URL(request.url).searchParams, keys = [...params.keys()];
      if (keys.some(key => key !== 'parts') || keys.length > 1) return failure(400, 'invalid_query', 'Only a parts filter is supported.');
      const requested = params.has('parts') ? params.get('parts').split(',').map(part => part.trim()) : null;
      if (requested && (!requested.length || requested.some(part => !PRICING_PARTS.includes(part)))) return failure(400, 'invalid_parts', 'Choose walkthrough, phone or owner pricing.');
      const quotes = can(actor, 'quotes.author', env), permitted = new Set([...(quotes ? ['walkthrough', 'phone'] : []), ...(isHubOwner(actor) ? ['owner'] : [])]);
      const parts = requested || [...permitted];
      if (!parts.length || parts.some(part => !permitted.has(part))) return failure(403, 'forbidden', 'This login cannot view internal prices.');
      try {
        return reply(200, { ok: true, authority: 'employee_hub', ...await pricingConfig(parts, { catalog }) });
      } catch (error) {
        if (error?.code?.startsWith('pricing_config_') && error.status < 500) return failure(error.status, error.code.slice('pricing_config_'.length), error.message);
        return failure(503, 'unavailable', 'Prices could not be loaded. Retry shortly; nothing was changed.');
      }
    },
  };
}

const handlers = pricingConfigHandlers();
export const onRequestGet = handlers.get;
