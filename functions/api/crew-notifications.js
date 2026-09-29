/* The signed-in employee's own schedule notices: GET lists their open
   notices and text settings, POST acknowledges notices or turns schedule
   texts on or off. Dispatchers also get GET ?view=team (who can be texted and
   notices that were not), and POST link_staff_contact and retry. Delivery
   never happens here; the messaging cron sends. */
import { getHubSession } from '../_lib/hub-session.js';
import { crewNotificationsEnabled } from '../_lib/crew-notifications.js';
import { createCrewNotificationFeed, crewNotificationStorage } from '../_lib/crew-notification-delivery.js';
import { employeeInvitationStore } from '../_lib/employee-accounts.js';

const MAX_BYTES = 8192;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code, error });
const ACTIONS = { acknowledge: 'acknowledge', set_preferences: 'setPreferences', link_staff_contact: 'linkStaffContact', retry: 'retry' };

// The only query is view=team; unknown or repeated keys are refused.
function view(request) {
  const params = new URL(request.url).searchParams, keys = [...params.keys()];
  if (keys.some(key => key !== 'view') || keys.length > 1 || (keys.length && params.get('view') !== 'team')) return null;
  return keys.length ? 'team' : 'own';
}

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  if (/^crew_notifications_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return failure(503, 'crew_notifications_unavailable', 'Your schedule notices could not be loaded. Retry the same request; nothing was changed twice.');
}

export function crewNotificationHandlers({
  session = getHubSession, storage = crewNotificationStorage, now = () => new Date(), readAccount = env => username => employeeInvitationStore(env).read(username),
} = {}) {
  const feed = env => createCrewNotificationFeed({ store: storage(env), env, now, readAccount: readAccount(env) });
  const disabled = () => failure(503, 'crew_notifications_not_enabled', 'Schedule notices are not turned on for this Hub yet.');
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) return failure(401, 'crew_notifications_sign_in_required', 'Sign in to the Employee Hub to see your schedule notices.');
        if (!crewNotificationsEnabled(env)) return disabled();
        const which = view(request);
        if (!which) return failure(400, 'crew_notifications_request_invalid', 'Use view=team or no query.');
        return reply(200, which === 'team' ? await feed(env).team(viewer) : await feed(env).list(viewer));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return failure(403, 'crew_notifications_origin_forbidden', 'Open the Employee Hub to change your schedule notices.');
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) return failure(401, 'crew_notifications_sign_in_required', 'Sign in to the Employee Hub to change your schedule notices.');
        if (!crewNotificationsEnabled(env)) return disabled();
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'crew_notifications_json_required', 'Notice changes must be JSON.');
        if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return failure(413, 'crew_notifications_request_too_large', 'The request is too large.');
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return failure(413, 'crew_notifications_request_too_large', 'The request is too large.');
        let input; try { input = JSON.parse(raw); } catch { return failure(400, 'crew_notifications_json_invalid', 'The request was incomplete. Refresh and try again.'); }
        if (!object(input) || !Object.hasOwn(ACTIONS, input.action)) return failure(400, 'crew_notifications_request_invalid', 'Use a supported notice action with a unique request ID.');
        return reply(200, await feed(env)[ACTIONS[input.action]](viewer, input));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = crewNotificationHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
