import { getHubSession } from '../_lib/hub-session.js';
import { lifecycleApiEnabled, lifecycleLimits, lifecycleStorage, mutateLifecycle, readLifecycle, requireLifecycleManager } from '../_lib/customer-lifecycle.js';

const LIMIT = 16000;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

// Reads also refuse sibling sites; writes refuse cross-site requests. A
// missing Origin is allowed only because the SameSite=Strict cookie is required.
function sameOrigin(request, read = false) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site' || read && site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function failure(error) {
  if (/^lifecycle_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'lifecycle_unavailable', error: 'The customer change could not be verified. Keep this request and retry it unchanged; do not create another.' });
}

// FUN-36. Reads take the Date; mutations take its ISO string. Writes stay off
// unless CUSTOMER_LIFECYCLE_API_ENABLED is exactly 'true' (the Hub keeps
// today's browser tools for credits, decisions and rebooking then).
export function customerLifecycleHandlers({ session = getHubSession, storage = lifecycleStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request, true)) return reply(403, { ok: false, code: 'lifecycle_origin_forbidden', error: 'Open customer credits in the Employee Hub.' });
      try {
        const actor = await session(request, env); requireLifecycleManager(actor, env);
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (keys.length !== 1 || keys[0] !== 'jobId') return reply(400, { ok: false, code: 'lifecycle_query_invalid', error: 'Choose one job.' });
        const at = now(), view = await readLifecycle(storage(env), actor, params.get('jobId'), lifecycleLimits(env), at);
        return reply(200, { ok: true, authority: 'employee_hub', enabled: lifecycleApiEnabled(env), ...view, asOf: at.toISOString() });
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'lifecycle_origin_forbidden', error: 'Open customer credits in the Employee Hub to save changes.' });
      if (!lifecycleApiEnabled(env)) return reply(404, { ok: false, code: 'lifecycle_api_disabled', error: 'Server customer actions are turned off. Use the standard customer tools.' });
      try {
        const actor = await session(request, env); requireLifecycleManager(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'lifecycle_json_required', error: 'Customer changes must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'lifecycle_request_too_large', error: 'The customer request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'lifecycle_request_too_large', error: 'The customer request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'lifecycle_json_invalid', error: 'The customer request was incomplete. Refresh the form and try again.' }); }
        return reply(200, await mutateLifecycle(storage(env), actor, input, now().toISOString(), lifecycleLimits(env)));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = customerLifecycleHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
