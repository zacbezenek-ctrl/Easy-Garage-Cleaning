/** The owner's targets and baselines (functions/_lib/owner-economics.js), entered on the Job actuals screen. Owner only:
 * every other login, managers included, gets 403 and no figures. The Playbook and Scorecard read the same values through
 * /api/pricing-config's owner part.
 * GET /api/owner-economics => {ok, settings:{<keys>, revision, updatedAt, updatedBy}, crewWageCentsPerManHour}. The crew
 *   wage is the Job actuals crew wage, shown here read-only and saved on the Cost settings card.
 * POST {action:'owner_economics.settings.set', requestId, expectedRevision, settings} => {ok, settings, requestId, replayed}.
 * Errors: {ok:false, code, error}; 400, 401, 403, 409 revision/idempotency, 413, 415, 503 retry the same request. */
import { getHubSession } from '../_lib/hub-session.js';
import { jobActualsSettingsStorage, readJobActualsSettings } from '../_lib/job-actuals-settings.js';
import { mutateOwnerEconomicsSettings, ownerEconomicsStorage, readOwnerEconomicsSettings, requireOwnerEconomicsOwner } from '../_lib/owner-economics.js';

const LIMIT = 8000;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^owner_economics_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'owner_economics_unavailable', error: 'Owner targets could not be loaded. Retry in a moment.' });
}

export function ownerEconomicsHandlers({ session = getHubSession, store = ownerEconomicsStorage, jobActuals = jobActualsSettingsStorage, now = () => new Date() } = {}) {
  // The crew wage is display-only here; when it cannot be read the owner's own settings still load.
  const crewWage = env => readJobActualsSettings(jobActuals(env)).then(costs => costs.wageCentsPerManHour, () => null);
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env).catch(() => null); requireOwnerEconomicsOwner(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'owner_economics_request_invalid', error: 'Owner targets take no query options.' });
        const [settings, crewWageCentsPerManHour] = await Promise.all([readOwnerEconomicsSettings(store(env)), crewWage(env)]);
        return reply(200, { ok: true, settings, crewWageCentsPerManHour });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'owner_economics_origin_forbidden', error: 'Open Job actuals in the Employee Hub to save owner targets.' });
      try {
        const actor = await session(request, env).catch(() => null); requireOwnerEconomicsOwner(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'owner_economics_json_required', error: 'Owner targets must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'owner_economics_request_too_large', error: 'The owner-targets request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'owner_economics_request_too_large', error: 'The owner-targets request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'owner_economics_json_invalid', error: 'The owner-targets request was incomplete. Reload and try again.' }); }
        const result = await mutateOwnerEconomicsSettings(store(env), actor, input, now().toISOString());
        return reply(200, { ok: true, settings: result.settings, requestId: result.requestId, replayed: result.replayed });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = ownerEconomicsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
