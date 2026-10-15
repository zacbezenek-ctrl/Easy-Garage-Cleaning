import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireQuoteAuthor } from '../_lib/quote-permissions.js';
import { approveQuoteDocument, readQuoteDocument } from '../_lib/quote-document-store.js';

const LIMIT = 4096;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = error => /^(quote_document_|quote_)/.test(error?.code || '') ? reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) }) : reply(503, { ok: false, code: 'quote_document_unavailable', error: 'The document snapshot could not be verified. Retry the same request.' });
const originAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  try { return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};

export function quoteDocumentHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date(), enabled = false } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireQuoteAuthor(actor, env);
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].length !== new Set(params.keys()).size) return reply(400, { ok: false, code: 'quote_document_invalid_request', error: 'Use each query field once.' });
        const input = Object.fromEntries(params);
        if (input.estimateRevision !== undefined) {
          if (!/^[1-9]\d{0,8}$/.test(input.estimateRevision)) return reply(400, { ok: false, code: 'quote_document_invalid_request', error: 'Use a positive estimate revision.' });
          input.estimateRevision = Number(input.estimateRevision);
        }
        return reply(200, await readQuoteDocument(storage(env), actor, input, now().toISOString(), { env, enabled }));
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!originAllowed(request)) return reply(403, { ok: false, code: 'quote_document_origin_forbidden', error: 'Approve internal drafts from the Employee Hub.' });
      try {
        const actor = await session(request, env); requireQuoteAuthor(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'quote_document_json_required', error: 'Use JSON for this approval.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'quote_document_too_large', error: 'Send only identifiers and expected versions.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'quote_document_too_large', error: 'Send only identifiers and expected versions.' });
        let body; try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'quote_document_invalid_json', error: 'The approval request is incomplete.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'approve_and_snapshot') return reply(400, { ok: false, code: 'quote_document_invalid_request', error: 'Choose the explicit internal approve_and_snapshot action.' });
        const { action, ...input } = body;
        return reply(200, await approveQuoteDocument(storage(env), actor, input, now().toISOString(), { env, enabled }));
      } catch (error) { return failure(error); }
    },
  };
}
const handlers = quoteDocumentHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
