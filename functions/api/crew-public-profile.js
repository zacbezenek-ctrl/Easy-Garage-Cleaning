import { getHubSession } from '../_lib/hub-session.js';
import { createFieldPhotoClient } from '../_lib/field-execution-photos.js';
import { CREW_PROFILES, approvedCrewPhoto, crewPhotoMetadataMatches, crewProfileDetail, crewProfileKey, crewProfileManager, crewProfileOverview, crewProfileStorage, mutateCrewProfile, pendingCrewPhoto, requireCrewProfileStaff } from '../_lib/crew-public-profile.js';

// A 6 MB photo is ~8 MB as base64 plus a small JSON envelope (the field photo cap).
const LIMIT = 9 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE = /^image\/(?:jpeg|png|webp)$/;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: 'crew_profile_' + code, status });
const failure = problem => problem?.code?.startsWith('crew_profile_')
  ? reply(problem.status || 503, { ok: false, code: problem.code, error: problem.message, ...(problem.details ? { details: problem.details } : {}) })
  : reply(503, { ok: false, code: 'crew_profile_unavailable', error: 'Crew profiles could not be verified. Keep this change and retry it; do not start another.' });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
const forbidden = () => reply(403, { ok: false, code: 'crew_profile_origin_forbidden', error: 'Open crew photos from the EGC Hub.' });

// Streams one saved headshot to signed-in staff: approved photos to anyone on the Hub (dispatch shows them),
// a pending photo only to its owner or a manager. The Drive file must still be this profile's own upload.
async function photo(store, actor, params, env, photos) {
  const key = crewProfileKey(params.get('photo')), state = params.get('state') ?? 'approved', version = params.get('v');
  if (!key || !['approved', 'pending'].includes(state) || version !== null && !UUID.test(version)) throw fail('request_invalid', 'Choose one crew photo.');
  if (state === 'pending' && key !== requireCrewProfileStaff(actor) && !crewProfileManager(actor, env)) throw fail('forbidden', 'Only the employee or a manager can review a pending photo.', 403);
  const profile = await store.read(CREW_PROFILES, key), record = state === 'pending' ? pendingCrewPhoto(profile) : approvedCrewPhoto(profile);
  if (!record) throw fail('photo_not_found', 'This crew photo is not available.', 404);
  let image;
  try {
    const client = await photos(env);
    if (!crewPhotoMetadataMatches(await client.metadata(record.fileId), key, record)) throw fail('photo_not_found', 'This crew photo is not available.', 404);
    image = await client.image(record.fileId);
  } catch (problem) { throw problem?.code === 'crew_profile_photo_not_found' ? problem : fail('photo_storage_unavailable', 'This photo is temporarily unavailable. Retry shortly.', 503); }
  const type = String(image.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE.test(type)) { await image.body?.cancel().catch(() => {}); throw fail('photo_storage_unavailable', 'This photo is temporarily unavailable. Retry shortly.', 503); }
  return new Response(image.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' } });
}

/**
 * Crew public profiles (P4-07) for the Hub and the crew photo page.
 * GET: the viewer's own profile; for a manager also every roster profile and every stored profile of someone
 * no longer on the roster (onRoster:false), which can be hidden and cleared but not shown to customers.
 * GET ?username=: one profile (own, or any for a manager).
 * GET ?photo=&state=approved|pending&v=: the saved headshot itself.
 * POST {action, requestId, username, expectedRevision, ...}: upload_photo {dataUrl} and remove_photo (own or
 * manager); approve_photo / reject_photo {photoRequestId} and set_profile {firstName, active} (manager only).
 * Nothing here sends anything to customers; the portal shows a profile only after a manager activates it.
 */
export function crewPublicProfileHandlers({ session = getHubSession, storage = crewProfileStorage, photos = createFieldPhotoClient, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        const actor = await session(request, env);
        requireCrewProfileStaff(actor);
        const params = new URL(request.url).searchParams, keys = [...params.keys()], store = storage(env);
        if (new Set(keys).size !== keys.length) throw fail('request_invalid', 'Each crew profile option can appear once.');
        if (!keys.length) return reply(200, await crewProfileOverview(store, actor, env));
        if (keys.length === 1 && keys[0] === 'username') return reply(200, await crewProfileDetail(store, actor, params.get('username'), env));
        if (keys.includes('photo') && keys.every(key => ['photo', 'state', 'v'].includes(key))) return await photo(store, actor, params, env, photos);
        throw fail('request_invalid', 'Choose a crew profile or photo.');
      } catch (problem) { return failure(problem); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return forbidden();
      try {
        const actor = await session(request, env);
        requireCrewProfileStaff(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'crew_profile_json_required', error: 'Send the crew profile change as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'crew_profile_request_too_large', error: 'This photo is too large. Choose a smaller photo.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'crew_profile_request_too_large', error: 'This photo is too large. Choose a smaller photo.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'crew_profile_json_invalid', error: 'The crew profile change was incomplete. Refresh and try again.' }); }
        return reply(200, await mutateCrewProfile({ store: storage(env), photos }, actor, input, env, now().toISOString()));
      } catch (problem) { return failure(problem); }
    },
  };
}

const handlers = crewPublicProfileHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
