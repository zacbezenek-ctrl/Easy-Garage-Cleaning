/* GHL-TRACK-1: the HighLevel tag outbox (functions/_lib/ghl-tag-outbox.js).
   POST {envelope}                  the Railway egc-worker's signed tick (ghl-tag-worker.ts), checked like the messaging
                                    cron: a v2 service envelope bound to this exact path, a single-use nonce, the EGC
                                    workspace and the ghl-tag-worker integration actor. Drains due entries, then
                                    records the worker's check-in (ghlTagDrainState).
   GET ?view=stuck                  dispatchers: parked entries and pending ones the drain is overdue on, counted by
                                    visit while still current, plus the worker's check-in (drain.stale), for the
                                    Command center (with the outbox off, {enabled:false} for any signed-in viewer).
   POST {action:'retry', requestId, jobId?}
                                    dispatchers: parked and overdue entries are due again with a fresh budget and
                                    get one attempt at once.
   Off unless EGC_GHL_TAG_OUTBOX is exactly "true". Nothing here sends a customer message. */
import { getHubSession } from '../_lib/hub-session.js';
import { canDispatch } from '../_lib/dispatch-permissions.js';
import { operationsAuthMode, operationsEnabled, verifyApiServiceEnvelope } from '../_lib/operations-service-auth.js';
import { drainGhlTagOutbox, ghlTagOutboxEnabled, ghlTagOutboxStorage, ghlTagStuck, recordGhlTagDrainCheckIn, retryGhlTags } from '../_lib/ghl-tag-outbox.js';

export const GHL_TAG_DRAIN_PATH = '/api/ghl-tag-drain';
/** Must equal GHL_TAG_WORKER_ACTOR_ID in egc-platform/apps/worker/src/ghl-tag-worker.ts. */
export const GHL_TAG_WORKER_ID = 'ghl-tag-worker';
const MAX_BYTES = 8192;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code, error });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  if (/^ghl_tag_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  return failure(503, 'ghl_tag_unavailable', 'HighLevel tag status could not be verified. Retry; nothing is sent twice.');
}

function authFailure(error) {
  const code = String(error?.code || '');
  if (code === 'operations_not_enabled' || code === 'service_signing_not_configured') return failure(503, 'ghl_tag_drain_not_configured', 'Signed service requests are not configured for the Hub.');
  if (error?.status === 409) return failure(409, 'ghl_tag_drain_replayed', 'This signed request was already used. Sign a new request.');
  if (error?.status === 401 || error?.message === 'Unauthorized') return failure(401, 'ghl_tag_drain_unauthorized', 'The signed service request could not be verified.');
  return failure(503, 'ghl_tag_drain_unavailable', 'The signed service request could not be checked. Retry with a new signature.');
}

export function ghlTagDrainHandlers({ verify = verifyApiServiceEnvelope, session = getHubSession, storage = ghlTagOutboxStorage, now = () => new Date(), fetcher = (...args) => fetch(...args) } = {}) {
  async function tick(env, envelope) {
    // The legacy shared-secret envelope has no path binding or nonce, so it never drives HighLevel writes.
    let v2 = false; try { v2 = operationsEnabled(env) && operationsAuthMode(env) === 'v2'; } catch {}
    if (!v2) return failure(503, 'ghl_tag_drain_not_configured', 'Signed service requests are not configured for the Hub.');
    const started = now();
    let claims;
    try { claims = await verify(env, envelope, GHL_TAG_DRAIN_PATH, { now: started.getTime() }); } catch (error) { return authFailure(error); }
    const actor = claims?.actor, command = claims?.request?.body;
    if (claims?.v !== 2 || claims.path !== GHL_TAG_DRAIN_PATH) return failure(401, 'ghl_tag_drain_unauthorized', 'The signed service request could not be verified.');
    if (actor?.workspace !== (env.EGC_OPERATIONS_WORKSPACE || 'egc')) return failure(403, 'ghl_tag_drain_forbidden', 'This workspace cannot drain HighLevel tags.');
    if (actor.id !== GHL_TAG_WORKER_ID || actor.kind !== 'integration' || actor.role !== 'integration') return failure(403, 'ghl_tag_drain_forbidden', 'Only the HighLevel tag worker can drain HighLevel tags.');
    if (!object(command) || Object.keys(command).length !== 1 || command.command !== 'ghl_tags.drain') return failure(400, 'ghl_tag_drain_command_invalid', 'Use ghl_tags.drain.');
    if (!ghlTagOutboxEnabled(env)) return failure(409, 'ghl_tag_outbox_disabled', 'The HighLevel tag outbox is turned off. Nothing was sent.');
    try {
      const store = storage(env), summary = await drainGhlTagOutbox(store, { env, now: started.toISOString(), fetcher });
      if (summary.code) return reply(503, { ok: false, code: summary.code, error: 'HighLevel is not configured for the Hub. Nothing was sent; the entries wait.', summary });
      // Only a pass that ran counts: a stopped, unconfigured or refused worker leaves the check-in to go stale.
      return reply(200, { ok: true, summary, checkedIn: await recordGhlTagDrainCheckIn(store, started.toISOString()) });
    } catch (error) { return errorResponse(error); }
  }
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer) return failure(401, 'ghl_tag_sign_in_required', 'Sign in to the Employee Hub to see HighLevel tag status.');
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (keys.length !== 1 || keys[0] !== 'view' || params.get('view') !== 'stuck') return failure(400, 'ghl_tag_request_invalid', 'Use view=stuck.');
        // Off, every signed-in viewer gets the same answer, so the Command center shows nothing new.
        if (!ghlTagOutboxEnabled(env)) return reply(200, { ok: true, enabled: false });
        if (!canDispatch(viewer, env)) return failure(403, 'ghl_tag_forbidden', 'Only an operations manager or owner can see HighLevel tag status.');
        return reply(200, await ghlTagStuck(storage(env), now().toISOString()));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env, waitUntil }) {
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'ghl_tag_json_required', 'Send JSON.');
      if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return failure(413, 'ghl_tag_request_too_large', 'The request is too large.');
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return failure(413, 'ghl_tag_request_too_large', 'The request is too large.');
      let body; try { body = JSON.parse(raw); } catch { return failure(400, 'ghl_tag_json_invalid', 'The request was incomplete.'); }
      if (object(body) && Object.keys(body).length === 1 && typeof body.envelope === 'string') return tick(env, body.envelope);
      if (!sameOrigin(request)) return failure(403, 'ghl_tag_origin_forbidden', 'Open the Employee Hub to retry HighLevel tags.');
      try {
        const viewer = await session(request, env);
        if (!viewer) return failure(401, 'ghl_tag_sign_in_required', 'Sign in to the Employee Hub to retry HighLevel tags.');
        if (!ghlTagOutboxEnabled(env)) return failure(409, 'ghl_tag_outbox_disabled', 'The HighLevel tag outbox is turned off.');
        const at = now().toISOString(), store = storage(env), result = await retryGhlTags(store, viewer, body, at, env);
        // One attempt right away; the worker keeps retrying on its own schedule.
        if (result.ids.length && typeof waitUntil === 'function') waitUntil(drainGhlTagOutbox(store, { env, now: at, ids: result.ids, fetcher }).catch(() => null));
        return reply(200, result);
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = ghlTagDrainHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
