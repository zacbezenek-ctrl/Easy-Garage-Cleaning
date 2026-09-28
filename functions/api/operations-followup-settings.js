import { getHubSession } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { operationsRoster } from '../_lib/operations-staff.js';
import { createFollowupSettingsService, followupSettingsStorage } from '../_lib/operations-followup-policy.js';

const LIMIT = 4096;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function errorResponse(error) {
  if (error?.code?.startsWith('followup_settings_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (error?.message === 'portal_members_ambiguous') return reply(409, { ok: false, code: 'followup_settings_roster_ambiguous', error: 'Staff identities need review before a follow-up owner can be chosen.' });
  return reply(503, { ok: false, code: 'followup_settings_unavailable', error: 'The follow-up settings could not be verified. Keep your change and retry the same save.' });
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
const forbidden = () => reply(403, { ok: false, code: 'followup_settings_origin_forbidden', error: 'Open the Employee Hub to change follow-up settings.' });

/**
 * P3-04 follow-up owner and due-time policy (operations_settings/followups).
 * GET: the saved settings, the live policy and the eligible owners (business users).
 * POST {requestId, expectedRevision, ownerId|null, dueMinutes, sendWindow:{startHour,endHour}, reason?}
 * (owner only). Nothing here contacts a customer.
 */
export function followupSettingsHandlers({ session = getHubSession, storage = followupSettingsStorage, roster = operationsRoster, now = () => new Date() } = {}) {
  function service(env) {
    if (!firebaseServiceAccountConfigured(env)) throw Object.assign(new Error('Hub storage is not configured.'), { code: 'followup_settings_not_configured', status: 503 });
    return createFollowupSettingsService({ store: storage(env), roster: () => roster(env), env, now });
  }
  return {
    async get({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'followup_settings_invalid_query', error: 'This request takes no query parameters.' });
        return reply(200, await service(env).read(await session(request, env)));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        const actor = await session(request, env);
        if (!actor?.user) return reply(401, { ok: false, code: 'followup_settings_sign_in_required', error: 'Sign in to the Employee Hub.' });
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'followup_settings_json_required', error: 'Send follow-up settings as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'followup_settings_request_too_large', error: 'The follow-up settings request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'followup_settings_request_too_large', error: 'The follow-up settings request is too large.' });
        let body; try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'followup_settings_json_invalid', error: 'The follow-up settings request was incomplete. Retry from the form.' }); }
        return reply(200, await service(env).save(actor, body));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = followupSettingsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
