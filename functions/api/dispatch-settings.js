/** Owner dispatch settings API (P1-DS-06). Session cookie, owner only
 * (settings.manage), same-origin JSON, no-store. Storage and defaults:
 * functions/_lib/dispatch-settings.js; the rules: functions/_lib/dispatch-rules.js.
 * GET /api/dispatch-settings
 *   => {ok,authority,settings:{revision|null,source:'defaults'|'firestore',values,
 *       invalidFields,updatedAt,updatedBy},defaults,skills:[{id,label}],
 *       environment:{arrival:{enabled,minutes},envArrivalMinutes,travelEstimates:
 *       'off'|'offline'|'google',envBlockTravelShort,staffDirectory},viewer:{id}}
 * POST {action:'settings.update',requestId,expectedRevision:string|null,
 *       changes:{defaultTravelBufferMinutes?,defaultArrivalWindowMinutes?,workdayStart?,
 *       workdayEnd?,blockCrewShort?,blockSkillMissing?,blockTravelShort?,
 *       blockOverCapacity?,blockOutsideHours?,maxJobsPerEmployeePerDay?,
 *       maxHoursPerEmployeePerDay?},reason?:string(500)}
 *   => the GET body plus {requestId,replayed}. Keep the same requestId and body
 *   when retrying; the same requestId with another body is 409
 *   dispatch_idempotency_conflict, a stale expectedRevision is 409
 *   dispatch_settings_revision_conflict (details.currentRevision), and 503
 *   dispatch_settings_busy (schedule saves kept winning the shared guard;
 *   nothing was saved) is retried with the same request.
 * Errors: {ok:false,code,error,details?}; 400, 401, 403, 409, 413, 415, 503. */
import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { dispatchSettingsOverview, effectiveArrivalSettings, mutateDispatchSettings, requireSettingsOwner } from '../_lib/dispatch-settings.js';
import { arrivalDefaults, arrivalSettings } from '../_lib/dispatch-arrival.js';
import { travelSettings } from '../_lib/dispatch-travel.js';
import { staffDirectoryEnabled } from '../_lib/staff-directory.js';

const LIMIT = 8192;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' } });
const tooLarge = () => reply(413, { ok:false, code:'dispatch_request_too_large', error:'The dispatch settings request is too large.' });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (error?.code?.startsWith('dispatch_')) return reply(error.status || 503, { ok:false, code:error.code, error:error.message, ...(error.details ? { details:error.details } : {}) });
  return reply(503, { ok:false, code:'dispatch_settings_unavailable', error:'Dispatch settings could not be verified. Keep your changes and retry the same request; it will not be saved twice.' });
}
// What the environment adds, so the editor can explain the rules that depend on it. No secrets.
function environment(env, values) {
  const travel = travelSettings(env);
  return { arrival: arrivalDefaults(effectiveArrivalSettings(arrivalSettings(env), values)), envArrivalMinutes: arrivalSettings(env).defaultArrivalWindowMinutes,
    travelEstimates: travel.mode, envBlockTravelShort: travel.blockShort, staffDirectory: staffDirectoryEnabled(env) };
}

export function dispatchSettingsHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireSettingsOwner(actor, env);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok:false, code:'dispatch_settings_invalid', error:'Dispatch settings take no query options.' });
        const body = await dispatchSettingsOverview(storage(env), actor, env);
        return reply(200, { ...body, environment: environment(env, body.settings.values) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok:false, code:'dispatch_origin_forbidden', error:'Open dispatch settings in the Employee Hub to save changes.' });
      try {
        const actor = await session(request, env); requireSettingsOwner(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok:false, code:'dispatch_json_required', error:'Dispatch settings must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return tooLarge();
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return tooLarge();
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok:false, code:'dispatch_json_invalid', error:'The dispatch settings request was incomplete. Reload the settings and try again.' }); }
        const body = await mutateDispatchSettings(storage(env), actor, input, now().toISOString(), env);
        return reply(200, { ...body, environment: environment(env, body.settings.values) });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = dispatchSettingsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
