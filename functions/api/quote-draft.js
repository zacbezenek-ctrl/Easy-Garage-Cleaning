import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireQuoteAuthor } from '../_lib/quote-permissions.js';
import { expireStaleCheckout, previewQuoteSend, readQuoteDraft, saveQuoteDraft, sendQuoteDraft } from '../_lib/quote-draft.js';
import { createEstimateReadyDelivery } from '../_lib/estimate-ready.js';
import { stripeRequest, stripeSecretKey } from '../_lib/customer-payments.js';
import { moneyTotalsMode } from '../_lib/money-core.js';
import { catalogQuotesEnabled, catalogStorage, readCatalogState } from '../_lib/catalog-store.js';
import { priceCatalogQuote } from '../_lib/catalog-quote.js';

/** Quote drafts (P2-07). Same-origin JSON, quote authors only (P2-12).
 * GET  /api/quote-draft?jobId=ID  => {ok, job: quote author DTO}
 * POST {action:'save', requestId, customerId, sourceWalkthroughId?, sourceRevision?, jobId?, expectedRevision?, draft}
 * POST {action:'send_preview', jobId, expectedRevision}  => {confirmToken, expiresAt, delivery, summary}
 * POST {action:'send', requestId, jobId, expectedRevision, confirmToken}
 * POST {action:'catalog_preview',catalogPricing:{catalogVersion,settingsVersion,items:[{id,itemId,quantity,customerSupplied}]}}
 * Retry a lost response with the SAME requestId and body. */
const LIMIT = 64000;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function failure(error) {
  if (/^(quote_|dispatch_|confirm_token_|purpose_key_)/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'quote_draft_unavailable', error: 'The quote could not be verified. Keep the saved request and retry it; do not start another quote.' });
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
const stripeFor = env => { const secret = stripeSecretKey(env); return secret ? (path, options) => stripeRequest(secret, path, options) : null; };

export function quoteDraftHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date(), delivery = (env, store) => createEstimateReadyDelivery({ store, env, clock: now }), stripe = stripeFor,
  catalogState = env => readCatalogState(catalogStorage(env)) } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireQuoteAuthor(actor, env);
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].length !== new Set(params.keys()).size) return reply(400, { ok: false, code: 'quote_draft_invalid_request', error: 'The quote lookup is invalid.' });
        return reply(200, { ...await readQuoteDraft(storage(env), actor, Object.fromEntries(params), { env }), viewer: { id: actor.user } });
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'quote_draft_origin_forbidden', error: 'Open the quote in the Employee Hub before saving.' });
      try {
        const actor = await session(request, env); requireQuoteAuthor(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'quote_draft_json_required', error: 'The quote must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'quote_draft_too_large', error: 'The quote is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'quote_draft_too_large', error: 'The quote is too large.' });
        let body; try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'quote_draft_json_invalid', error: 'The quote request is incomplete.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, code: 'quote_draft_invalid_request', error: 'The quote request is incomplete.' });
        const { action, ...input } = body, store = storage(env), at = now().toISOString();
        if (action === 'catalog_preview') {
          if (Object.keys(input).some(key => key !== 'catalogPricing')) return reply(400, { ok: false, code: 'quote_draft_invalid_request', error: 'Preview one catalog selection at a time.' });
          if (!catalogQuotesEnabled(env)) return reply(404, { ok: false, code: 'quote_draft_catalog_disabled', error: 'Catalog quotes are turned off.' });
          const { storedLineItems, ...priced } = priceCatalogQuote(await catalogState(env), input.catalogPricing, at);
          return reply(200, { ok: true, authority: 'employee_hub', ...priced });
        }
        if (action === 'save') return reply(200, await saveQuoteDraft(store, actor, input, at, { env, catalogState, checkouts: job => expireStaleCheckout({ store, job, stripe: stripe(env), now: at, mode: moneyTotalsMode(env) }) }));
        if (action === 'send_preview') return reply(200, await previewQuoteSend(store, actor, input, at, { env }));
        if (action === 'send') return reply(200, await sendQuoteDraft(store, actor, input, at, { env, deliver: delivery(env, store).deliver }));
        return reply(400, { ok: false, code: 'quote_draft_invalid_request', error: 'Choose save, catalog_preview, send_preview or send.' });
      } catch (error) { return failure(error); }
    },
  };
}
const handlers = quoteDraftHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
