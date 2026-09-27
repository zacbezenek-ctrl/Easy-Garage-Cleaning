/**
 * GET /api/stripe-reviews — managers (requireDispatcher) see the Stripe items
 * the webhook held for a person: confirmed crew charges that could not be
 * applied to their job (payment_reviews) and Garage Guard members without an
 * exact Hub customer link (membership_reviews). Read-only; no query params.
 */
import { getHubSession } from '../_lib/hub-session.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { stripeReviewOverview, stripeReviewStorage } from '../_lib/stripe-reviews.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export function stripeReviewHandlers({ session = getHubSession, storage = stripeReviewStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        requireDispatcher(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'stripe_review_invalid_query', error: 'Stripe reviews take no query parameters.' });
        return reply(200, await stripeReviewOverview(storage(env), actor, now()));
      } catch (error) {
        if (/^(stripe_review_|dispatch_)/.test(String(error?.code || ''))) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'stripe_review_unavailable', error: 'Stripe reviews could not be loaded. Retry.' });
      }
    },
  };
}

const handlers = stripeReviewHandlers();
export const onRequestGet = handlers.get;
