import { getHubSession } from '../_lib/hub-session.js';
import { cleanupExpiredRecords } from '../_lib/rate-limit.js';
import { NOTES_LIMITS, WALKTHROUGH_NOTE_PARTS, confirmWalkthroughNotes, draftWalkthroughNotes, openaiKey, transcribeWalkthroughPart, walkthroughNotesActor, walkthroughNotesReady, walkthroughNotesState, walkthroughNotesStorage, withdrawWalkthroughNotes } from '../_lib/walkthrough-notes.js';

// EGC_WALKTHROUGH_NOTES (functions/_lib/walkthrough-notes.js):
//   GET                  {ok, enabled}: whether the recorder uploads here (switched on and the openaiapi key set).
//   GET ?visitId=        the notes panel's state for one walkthrough visit.
//   POST multipart       one recorder part (requestId, portalJobId, partIndex, partCount, source, audio): transcribed,
//                        answered {ok, alreadySaved, recording:{id}} like /api/operations-recordings, with refusals as
//                        {error: code} so the recorder's upload transport reads them unchanged.
//   POST JSON            {action: draft | confirm | withdraw, ...}.
const JSON_LIMIT = 64 * 1024;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
function failure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^(?:walkthrough_notes_|recording_)/.test(code)) return reply(error.status || 503, { ok: false, code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  console.error('walkthrough notes: unexpected failure', code || error?.name || 'error');
  return reply(503, { ok: false, code: 'walkthrough_notes_unavailable', error: 'Walkthrough notes are unavailable right now. Try again shortly.', details: { retryable: true } });
}
// An upload refusal keeps its recording_ code; anything else (storage, a busy commit) is the retryable recording_unavailable.
function uploadFailure(error) {
  const code = typeof error?.code === 'string' && /^recording_/.test(error.code) ? error.code : 'recording_unavailable';
  if (code === 'recording_unavailable' && error?.code !== code) console.error('walkthrough notes: upload failed', error?.code || error?.name || 'error');
  return reply(code === 'recording_unavailable' ? 503 : error.status || 503, { ok: false, error: code, message: code === 'recording_unavailable' ? 'Transcription is unavailable right now. The audio stays on this iPad and is sent again.' : error.message, ...(error?.details?.retryable || code === 'recording_unavailable' ? { retryable: true } : {}) });
}

export function walkthroughNotesHandlers({ session = getHubSession, storage = walkthroughNotesStorage, openai = (...args) => fetch(...args), now = () => new Date(), random = bytes => crypto.getRandomValues(bytes), cleanup = cleanupExpiredRecords } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if (!actor) return reply(401, { ok: false, code: 'walkthrough_notes_sign_in_required', error: 'Sign in to the Employee Hub to see walkthrough notes.' });
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (keys.some(key => key !== 'visitId') || new Set(keys).size !== keys.length) return reply(400, { ok: false, code: 'walkthrough_notes_invalid', error: 'Choose one walkthrough visit.' });
        // Switched off (or no OpenAI key), the answer is only that: nothing is read, and the recorder keeps the recording service.
        if (!walkthroughNotesReady(env)) return reply(200, { ok: true, enabled: false });
        if (!walkthroughNotesActor(actor, env)) return reply(403, { ok: false, code: 'walkthrough_notes_forbidden', error: 'This account cannot see walkthrough notes.' });
        if (!params.has('visitId')) return reply(200, { ok: true, enabled: true });
        return reply(200, await walkthroughNotesState(storage(env), actor, { visitId: params.get('visitId') }));
      } catch (error) { return failure(error); }
    },
    async post(context) {
      const { request, env } = context;
      const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() || '', upload = type === 'multipart/form-data';
      const refuse = (status, code, message) => reply(status, upload ? { ok: false, error: code, message } : { ok: false, code, error: message });
      try {
        if (!sameOrigin(request)) return refuse(403, 'walkthrough_notes_origin_forbidden', 'Open the walkthrough in the Employee Hub before sending it.');
        const actor = await session(request, env);
        // Like the recording service: an expired Hub session reads business_session_required, so the audio waits for sign-in.
        if (!actor) return upload ? reply(403, { ok: false, error: 'business_session_required', message: 'Sign in to the Employee Hub to send walkthrough audio.' }) : reply(401, { ok: false, code: 'walkthrough_notes_sign_in_required', error: 'Sign in to the Employee Hub to change walkthrough notes.' });
        if (!walkthroughNotesReady(env)) return refuse(503, 'walkthrough_notes_disabled', 'Walkthrough notes are switched off.');
        const store = storage(env), at = now().toISOString(), deps = { openai, apiKey: openaiKey(env), now: at };
        if (upload) {
          if (Number(request.headers.get('Content-Length') || 0) > NOTES_LIMITS.requestBytes) return refuse(413, 'recording_size_invalid', 'Each part must be 24 MB or smaller.');
          let form;
          try { form = await request.formData(); } catch { return refuse(400, 'recording_request_invalid', 'The upload could not be read.'); }
          const result = await transcribeWalkthroughPart(store, actor, { requestId: form.get('requestId'), visitId: form.get('portalJobId'), partIndex: form.get('partIndex'), partCount: form.get('partCount'), source: form.get('source'), file: form.get('audio') }, deps);
          // Now and then, after the reply: transcript parts past their 90 days are deleted (rate-limit.js cleanupExpiredRecords).
          if (random(new Uint8Array(1))[0] < 16) {
            const sweep = cleanup(env, WALKTHROUGH_NOTE_PARTS, at).catch(() => 0);
            if (typeof context.waitUntil === 'function') context.waitUntil(sweep);
          }
          return reply(200, result);
        }
        if (type !== 'application/json') return refuse(415, 'walkthrough_notes_json_required', 'Send the notes action as JSON.');
        if (Number(request.headers.get('Content-Length') || 0) > JSON_LIMIT) return refuse(413, 'walkthrough_notes_too_large', 'The notes are too long.');
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > JSON_LIMIT) return refuse(413, 'walkthrough_notes_too_large', 'The notes are too long.');
        let input;
        try { input = JSON.parse(raw); } catch { return refuse(400, 'walkthrough_notes_json_invalid', 'The notes request could not be read.'); }
        const act = { draft: draftWalkthroughNotes, confirm: confirmWalkthroughNotes, withdraw: withdrawWalkthroughNotes }[input?.action];
        if (!act) return refuse(400, 'walkthrough_notes_invalid', 'Choose draft, confirm or withdraw.');
        return reply(200, await act(store, actor, input, deps));
      } catch (error) { return upload ? uploadFailure(error) : failure(error); }
    },
  };
}

const handlers = walkthroughNotesHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
