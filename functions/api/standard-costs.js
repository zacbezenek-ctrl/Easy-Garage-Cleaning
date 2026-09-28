/** Owner standard unit costs for stocked catalog items (FUN-19). Session cookie: owner and manager business
 * sessions read; only the owner writes. Storage and rules: functions/_lib/standard-costs.js.
 * GET /api/standard-costs => {ok,authority,basis,asOf,catalogVersion,revision,updatedAt,updatedBy,categories,
 *   items:[{id,name,category,priceUnit,standardUnitCostCents|null,updatedAt,updatedBy}],retired,coverage:{set,total},canEdit}
 *   standardUnitCostCents null means no standard cost (unknown), never a retail price.
 * POST {action:'standard_costs.set',requestId,expectedRevision,changes:[{itemId,standardUnitCostCents|null}],reason?} (owner)
 *   => the overview plus {requestId,replayed}. Keep the same requestId and body when retrying; the same
 *   requestId with another body is a 409.
 * Errors: {ok:false,code,error,details?}; 400 validation, 401, 403, 409 revision/idempotency, 413, 415,
 * 503 retry the same request. */
import { getHubSession } from '../_lib/hub-session.js';
import { mutateStandardCosts, requireStandardCostOwner, standardCostOverview, standardCostStorage } from '../_lib/standard-costs.js';

const LIMIT = 32000;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^standard_cost_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'standard_cost_unavailable', error: 'Standard costs could not complete this request. Keep your changes and retry the same save; it will not be applied twice.' });
}

export function standardCostHandlers({ session = getHubSession, storage = standardCostStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'standard_cost_request_invalid', error: 'Standard costs take no query options.' });
        return reply(200, await standardCostOverview(storage(env), actor, now()));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'standard_cost_origin_forbidden', error: 'Open stocked item costs in the Employee Hub to save changes.' });
      try {
        const actor = await session(request, env); requireStandardCostOwner(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'standard_cost_json_required', error: 'Standard-cost changes must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'standard_cost_request_too_large', error: 'Save fewer item costs at a time.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'standard_cost_request_too_large', error: 'Save fewer item costs at a time.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'standard_cost_json_invalid', error: 'The standard-cost request was incomplete. Reload and try again.' }); }
        return reply(200, await mutateStandardCosts(storage(env), actor, input, now().toISOString()));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = standardCostHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
