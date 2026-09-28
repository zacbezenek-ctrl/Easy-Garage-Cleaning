import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { fieldFailure, fieldFingerprint, fieldId, fieldRequestId } from '../_lib/field-execution.js';
import { createFieldStore } from '../_lib/field-execution-store.js';
import { customerPhotoPolicy, customerPhotosEnabled, photoSharingCommand, photoSharingView } from '../_lib/customer-photo-visibility.js';

// Managers choose which verified field photos the customer portal may show.
// Writes reuse the field store commit: the job patch and a management-only
// fieldEvents receipt land together behind the job's updateTime.
const MAX_BYTES = 8 * 1024;
const KEYS = new Set(['jobId', 'photoId', 'customerVisible', 'confirm', 'requestId', 'expectedRevision', 'expectedUser']);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};

function errorResponse(error) {
  return reply(error.status || 503, { ok: false, code: error.code || 'FIELD_SERVICE_UNAVAILABLE', error: error.code ? error.message : 'Photo sharing is temporarily unavailable. The change has not been confirmed; retry to check its result.' });
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fieldFailure('Photo sharing changes must use JSON.', 415, 'FIELD_REQUEST_INVALID');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) throw fieldFailure('This photo sharing change is too large.', 413, 'FIELD_REQUEST_TOO_LARGE');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw fieldFailure('This photo sharing change is too large.', 413, 'FIELD_REQUEST_TOO_LARGE');
  let body; try { body = JSON.parse(raw); } catch { throw fieldFailure('The photo sharing change could not be read.', 400, 'FIELD_JSON_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !KEYS.has(key))) throw fieldFailure('Choose a supported photo sharing change.');
  if (!fieldId(body.jobId) || !fieldRequestId(body.requestId) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || body.expectedRevision.length > 80) throw fieldFailure('A job, unique action ID and current job version are required. Refresh and retry.');
  return body;
}

export function fieldPhotoSharingHandlers({ session = getHubSession, storage = createFieldStore, now = () => new Date() } = {}) {
  async function context(request, env) {
    if (!customerPhotosEnabled(env)) throw fieldFailure('Customer photo sharing is not enabled.', 404, 'FIELD_CUSTOMER_PHOTOS_DISABLED');
    const actor = await session(request, env);
    if (!actor) throw fieldFailure('Sign in to the Employee Hub to manage customer photos.', 401, 'FIELD_AUTH_REQUIRED');
    if (!hasBusinessAccess(actor) || !['owner', 'manager'].includes(actor.role)) throw fieldFailure('Only an operations manager or owner can choose customer-visible photos.', 403, 'FIELD_PHOTO_SHARING_FORBIDDEN');
    if (!firebaseServiceAccountConfigured(env)) throw fieldFailure('Secure job storage is not connected. Contact operations.', 503, 'FIELD_STORAGE_UNAVAILABLE');
    return { actor, store: storage(env), policy: customerPhotoPolicy(env) };
  }
  async function job(ctx, id) {
    if (!fieldId(id)) throw fieldFailure('Choose a valid job.');
    const found = await ctx.store.readJob(id);
    if (!found || !['job', 'cleanout', 'reorg'].includes(found.type) || found.recordType) throw fieldFailure('This job is unavailable.', 404, 'FIELD_JOB_NOT_FOUND');
    return found;
  }
  const view = async (ctx, id) => ({ ok: true, viewer: ctx.actor.user, ...photoSharingView(await job(ctx, id), ctx.policy) });

  async function get({ request, env }) {
    try {
      const ctx = await context(request, env), params = [...new URL(request.url).searchParams];
      if (params.length !== 1 || params[0][0] !== 'jobId') throw fieldFailure('Choose one job.');
      return reply(200, await view(ctx, params[0][1]));
    } catch (error) { return errorResponse(error); }
  }

  async function post({ request, env }) {
    let ctx, input, fingerprint;
    try {
      if (!mutationOriginAllowed(request)) throw fieldFailure('Photo sharing changes must come from the Employee Hub.', 403, 'FIELD_ORIGIN_FORBIDDEN');
      ctx = await context(request, env); input = await readBody(request);
      if (input.expectedUser !== undefined && (typeof input.expectedUser !== 'string' || input.expectedUser.toLowerCase() !== ctx.actor.user.toLowerCase())) throw fieldFailure('Your signed-in account changed. Sign in again before retrying this change.', 401, 'FIELD_ACCOUNT_CHANGED');
      const current = await job(ctx, input.jobId);
      fingerprint = await fieldFingerprint(ctx.actor.user, input);
      const receipt = await ctx.store.readEvent(current.id, input.requestId);
      if (receipt && receipt.fingerprint !== fingerprint) throw fieldFailure('This action ID was already used for different information. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
      if (receipt?.state === 'applied') return reply(200, { ...await view(ctx, current.id), alreadyApplied: true });
      if (receipt) throw fieldFailure('This change is pending verification. Retry shortly.', 409, 'FIELD_ACTION_PENDING');
      if (current.__updateTime !== input.expectedRevision) throw fieldFailure('This job changed. Review the latest photo sharing before retrying.', 409, 'FIELD_REVISION_CONFLICT');
      const { patch, event } = photoSharingCommand(current, ctx.actor, input, now().toISOString());
      await ctx.store.commit(current, patch, { ...event, fingerprint });
      return reply(200, { ...await view(ctx, current.id), alreadyApplied: false });
    } catch (error) {
      // A lost commit response is recovered from the receipt, never assumed.
      if (ctx && input && fingerprint && ['FIELD_STORAGE_UNAVAILABLE', 'FIELD_REVISION_CONFLICT'].includes(error.code)) {
        try { const receipt = await ctx.store.readEvent(input.jobId, input.requestId); if (receipt?.state === 'applied' && receipt.fingerprint === fingerprint) return reply(200, { ...await view(ctx, input.jobId), alreadyApplied: true }); } catch { /* The original error remains actionable. */ }
      }
      return errorResponse(error);
    }
  }
  return { get, post };
}

const handlers = fieldPhotoSharingHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
