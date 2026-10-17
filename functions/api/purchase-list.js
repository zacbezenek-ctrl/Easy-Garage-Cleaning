/** GET/POST /api/purchase-list: the office purchase list (WP14c). Rules and storage: functions/_lib/purchase-list.js.
 * Switched on by EGC_JOB_MATERIALS (exactly "true"); off, both answer 404 purchase_list_disabled and read nothing. */
import { getHubSession } from '../_lib/hub-session.js';
import { jobMaterialsEnabled } from '../_lib/job-materials.js';
import { markPurchase, purchaseListStorage, purchaseOverview, requirePurchaseList } from '../_lib/purchase-list.js';

const LIMIT = 16384;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const disabled = () => reply(404, { ok: false, code: 'purchase_list_disabled', error: 'The purchase list is not switched on for this Hub.' });
function failure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^purchase_/.test(code)) return reply(error.status || 400, { ok: false, code, error: error.message });
  if (code === 'FIELD_REVISION_CONFLICT') return reply(409, { ok: false, code: 'purchase_revision_conflict', error: 'This job changed while the purchase was saved. Refresh the purchase list and retry.' });
  return reply(503, { ok: false, code: 'purchase_unavailable', error: 'The purchase list is unavailable. Your change has not been confirmed; retry to check its result.' });
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export function purchaseListHandlers({ session = getHubSession, storage = purchaseListStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!jobMaterialsEnabled(env)) return disabled();
      try {
        const actor = await session(request, env); requirePurchaseList(actor, env);
        return reply(200, await purchaseOverview(storage(env), actor, Object.fromEntries(new URL(request.url).searchParams), { env, now: now() }));
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!jobMaterialsEnabled(env)) return disabled();
      try {
        if (!sameOrigin(request)) return reply(403, { ok: false, code: 'purchase_origin_forbidden', error: 'Open the purchase list in the Employee Hub before changing it.' });
        const actor = await session(request, env); requirePurchaseList(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'purchase_json_required', error: 'The purchase change must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'purchase_too_large', error: 'The purchase change is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'purchase_too_large', error: 'The purchase change is too large.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'purchase_request_invalid', error: 'The purchase change could not be read.' }); }
        return reply(200, await markPurchase(storage(env), actor, input, { env, now: now() }));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = purchaseListHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
