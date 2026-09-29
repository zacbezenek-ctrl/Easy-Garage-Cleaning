import { getHubSession } from '../_lib/hub-session.js';
import { recordWalkthroughVisit, walkthroughVisitEnabled, walkthroughVisitState, walkthroughVisitStorage } from '../_lib/walkthrough-visit.js';
import { firstGhlTagAttempt, ghlTagChangeKey, ghlTagEntryId, ghlTagOutboxEnabled } from '../_lib/ghl-tag-outbox.js';

const LIMIT = 8192;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function failure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^walkthrough_visit_/.test(code)) return reply(error.status || 503, { ok: false, code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  // A funnel event the visit cannot produce is deterministic: retrying the same request cannot succeed.
  if (/^funnel_event_/.test(code)) return reply(400, { ok: false, code: 'walkthrough_visit_invalid', error: 'This walkthrough action cannot be recorded for this visit. Nothing was saved; ask a manager to check the visit.', details: { cause: code } });
  return reply(503, { ok: false, code: 'walkthrough_visit_unavailable', error: 'The walkthrough could not be verified. Keep this request and retry it; do not tap again.' });
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export function walkthroughVisitHandlers({ session = getHubSession, storage = walkthroughVisitStorage, now = () => new Date(), ghlTags = firstGhlTagAttempt } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if (!actor) return reply(401, { ok: false, code: 'walkthrough_visit_sign_in_required', error: 'Sign in to the Employee Hub to record walkthroughs.' });
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (keys.some(key => key !== 'visitId') || new Set(keys).size !== keys.length) return reply(400, { ok: false, code: 'walkthrough_visit_invalid', error: 'Choose one walkthrough visit.' });
        // Switched off, the answer is only that: no visit, lock or timecard read (the gameplan asks on every open).
        if (!walkthroughVisitEnabled(env)) return reply(200, { ok: true, enabled: false });
        return reply(200, { ...await walkthroughVisitState(storage(env), actor, Object.fromEntries(params), now().toISOString()), enabled: walkthroughVisitEnabled(env) });
      } catch (error) { return failure(error); }
    },
    async post({ request, env, waitUntil }) {
      try {
        if (!sameOrigin(request)) return reply(403, { ok: false, code: 'walkthrough_visit_origin_forbidden', error: 'Open the walkthrough in the Employee Hub before recording it.' });
        const actor = await session(request, env);
        if (!actor) return reply(401, { ok: false, code: 'walkthrough_visit_sign_in_required', error: 'Sign in to the Employee Hub to record walkthroughs.' });
        if (!walkthroughVisitEnabled(env)) return reply(503, { ok: false, code: 'walkthrough_visit_disabled', error: 'Walkthrough Start and Finish are not switched on yet. Record this visit the way you do today.' });
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'walkthrough_visit_json_required', error: 'The walkthrough action must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'walkthrough_visit_too_large', error: 'The walkthrough action is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'walkthrough_visit_too_large', error: 'The walkthrough action is too large.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'walkthrough_visit_json_invalid', error: 'The walkthrough action could not be read.' }); }
        const at = now().toISOString(), result = await recordWalkthroughVisit(storage(env), actor, input, at);
        // EGC_GHL_TAG_OUTBOX: an outcome's HighLevel tags (if it queued any) get their first attempt after the response.
        if (ghlTagOutboxEnabled(env) && result.action !== 'start') ghlTags({ env, waitUntil }, [await ghlTagEntryId(result.visit?.id, ghlTagChangeKey('walkthrough-outcome', result.requestId))], at);
        return reply(200, result);
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = walkthroughVisitHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
