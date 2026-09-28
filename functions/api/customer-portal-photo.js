import { readCookie, verifyCustomerPortalSessionToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { readBusinessProjectViewer } from '../_lib/business-hub-store.js';
import { customerPhotoPolicy, customerPhotosEnabled, customerPortalPhoto } from '../_lib/customer-photo-visibility.js';
import { createFieldPhotoClient } from '../_lib/field-execution-photos.js';
import { readJob } from '../_lib/firestore-job.js';

// Streams one customer-visible field photo after the portal session proves it
// owns the job on this request. Drive files stay private: no Drive URL or file
// id ever leaves this function, and every miss looks the same (404).
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
// Field uploads are only ever JPEG, PNG or WebP (decodeFieldPhoto), and the
// Drive client refuses anything else; this re-check keeps the response type exact.
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

const missing = () => reply(404, { ok: false, code: 'CUSTOMER_PORTAL_PHOTO_NOT_FOUND', error: 'This photo is not available.' });
const unavailable = () => reply(503, { ok: false, code: 'CUSTOMER_PORTAL_PHOTO_UNAVAILABLE', error: 'This photo is temporarily unavailable. Please try again shortly.' });

async function handleGet({ request, env }, { clock, read, businessRead, photos }) {
  if (!customerPhotosEnabled(env)) return missing();
  if (!allowed(request)) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_ORIGIN_FORBIDDEN', error: 'Forbidden origin' });
  const params = [...new URL(request.url).searchParams];
  if (params.length !== 1 || params[0][0] !== 'photoId') return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_PHOTO_INVALID', error: 'Choose one project photo.' });
  let result;
  try { result = await readCustomerPortalContext(env, await verifyCustomerPortalSessionToken(env, readCookie(request), clock().getTime()), { read, businessRead }); }
  catch (error) { return reply(error.status || 503, { ok: false, code: error.code || 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: error.code ? error.message : 'Your project could not be loaded. Please try again shortly.' }); }
  if (result.session.permissions?.view === false) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_ACCESS_REVOKED', error: 'Your access to this private project has changed.' });
  const photo = customerPortalPhoto(result.job, params[0][1], customerPhotoPolicy(env));
  if (!photo) return missing();
  try {
    const client = await photos(env), metadata = await client.metadata(photo.fileId);
    // The Drive file must still be this job's own upload, even if a job
    // document were edited to point at another customer's file.
    if (!metadata || metadata.trashed || metadata.appProperties?.egcJobId !== result.job.id || metadata.appProperties?.egcFieldRequestId !== photo.id) return missing();
    const image = await client.image(photo.fileId), type = String(image.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE.test(type)) { await image.body?.cancel().catch(() => {}); return unavailable(); }
    return new Response(image.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' } });
  } catch { return unavailable(); }
}

export function createCustomerPortalPhotoHandlers({ now = () => new Date(), read = readJob, businessRead = readBusinessProjectViewer, photos = createFieldPhotoClient } = {}) {
  const deps = { clock: now, read, businessRead, photos };
  return { onRequestGet: context => handleGet(context, deps) };
}

export const onRequestGet = createCustomerPortalPhotoHandlers().onRequestGet;
