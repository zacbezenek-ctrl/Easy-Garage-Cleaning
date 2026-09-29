import { readCookie, verifyCustomerPortalSessionToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { readBusinessProjectViewer } from '../_lib/business-hub-store.js';
import { createFieldPhotoClient } from '../_lib/field-execution-photos.js';
import { readJob } from '../_lib/firestore-job.js';
import { crewPhotoMetadataMatches, crewProfileStorage, crewPublicProfilesEnabled, resolveCustomerCrewPhoto } from '../_lib/crew-public-profile.js';

// Streams the approved headshot of a crew member assigned to the portal
// session's own job. The link is signed for that job, crew member and photo
// and expires; the session is re-checked on every request. No username,
// Drive URL or file id ever leaves this function.
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const IMAGE = /^image\/(?:jpeg|png|webp)$/;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

const missing = () => reply(404, { ok: false, code: 'CUSTOMER_PORTAL_CREW_PHOTO_NOT_FOUND', error: 'This photo is not available.' });
const expired = () => reply(403, { ok: false, code: 'CUSTOMER_PORTAL_CREW_PHOTO_LINK_INVALID', error: 'This photo link has expired. Refresh your project page.' });
const unavailable = () => reply(503, { ok: false, code: 'CUSTOMER_PORTAL_CREW_PHOTO_UNAVAILABLE', error: 'This photo is temporarily unavailable. Please try again shortly.' });

async function handleGet({ request, env }, { clock, read, businessRead, storage, photos }) {
  if (!crewPublicProfilesEnabled(env)) return missing();
  if (!allowed(request)) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_ORIGIN_FORBIDDEN', error: 'Forbidden origin' });
  const entries = [...new URL(request.url).searchParams], params = Object.fromEntries(entries);
  if (entries.length !== 3 || Object.keys(params).sort().join(',') !== 'exp,sig,u') return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_CREW_PHOTO_INVALID', error: 'Choose one crew photo.' });
  const at = clock();
  let result;
  try { result = await readCustomerPortalContext(env, await verifyCustomerPortalSessionToken(env, readCookie(request), at.getTime()), { read, businessRead }); }
  catch (error) { return reply(error.status || 503, { ok: false, code: error.code || 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: error.code ? error.message : 'Your project could not be loaded. Please try again shortly.' }); }
  if (result.session.permissions?.view === false) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_ACCESS_REVOKED', error: 'Your access to this private project has changed.' });
  let found;
  try { const store = storage(env); found = await resolveCustomerCrewPhoto(env, result.job, params, { read: (collection, id) => store.read(collection, id), now: at }); }
  catch { return unavailable(); }
  if (found.status === 'invalid') return expired();
  if (found.status !== 'ok') return missing();
  try {
    const client = await photos(env);
    // The Drive file must still be this crew member's own approved upload.
    if (!crewPhotoMetadataMatches(await client.metadata(found.photo.fileId), found.key, found.photo)) return missing();
    const image = await client.image(found.photo.fileId), type = String(image.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE.test(type)) { await image.body?.cancel().catch(() => {}); return unavailable(); }
    return new Response(image.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' } });
  } catch { return unavailable(); }
}

export function createCustomerCrewPhotoHandlers({ now = () => new Date(), read = readJob, businessRead = readBusinessProjectViewer, storage = crewProfileStorage, photos = createFieldPhotoClient } = {}) {
  const deps = { clock: now, read, businessRead, storage, photos };
  return { onRequestGet: context => handleGet(context, deps) };
}

export const onRequestGet = createCustomerCrewPhotoHandlers().onRequestGet;
