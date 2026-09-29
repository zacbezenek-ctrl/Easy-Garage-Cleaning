/**
 * GET /api/stripe-reviews — managers (requireDispatcher) see the Stripe items
 * the webhook held for a person: confirmed crew charges that could not be
 * applied to their job (payment_reviews) and Garage Guard members without an
 * exact Hub customer link (membership_reviews). No query params.
 * POST /api/stripe-reviews {action, requestId, reviewId, expectedRevision, ...}
 * resolves one open review: payment.reconcile {note} (checked against Stripe,
 * read-only: a charge Stripe shows refunded is never reconciled; managers get
 * 403 and the owner 409 stripe_review_refund_shown with the amounts, and records
 * it with payment.refund instead; a review flagged refunded that Stripe no
 * longer shows refunded is the owner's to reconcile; a test-mode charge Stripe
 * has no record of for the configured account, because no key is set or the
 * key is a live key, is the owner's to reconcile without the check, audited
 * owner-only; a live-mode charge is never closed without the check, so it stays
 * 409 stripe_review_stripe_unconfigured / stripe_review_stripe_not_found for
 * everyone until the live key is set), payment.refund {reason, note, jobPaymentAcknowledged?,
 * keptCentsAcknowledged?} (owner only, confirmed against Stripe; the first
 * acknowledgement is required when the charge is already on the job, the second
 * (the exact cents kept, from the 409 stripe_review_refund_partial details) when
 * Stripe shows only part of a charge that is not on the job refunded; on a
 * tipped charge, tipRefundedFirst? says the crew tip was refunded before the
 * service, and the service part kept must already be recorded on the job, or
 * it is 409 stripe_review_kept_not_recorded), membership.link {customerId},
 * membership.dismiss {reason, note}. Nothing
 * here charges, refunds or messages. A resolved payment review is final: the
 * crew return and webhook never put that charge on the job afterwards. A
 * payment reviewId is the checkout session ID, or {sessionId}:refund (then
 * {sessionId}:refund:2, :3 ...) for a refund Stripe showed after that charge's
 * review was closed, beyond what it settled (each GET row names it in reviewId).
 */
import { getHubSession } from '../_lib/hub-session.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { paymentReviewCheckoutBlockEnabled } from '../_lib/customer-payments.js';
import { resolveStripeReview, stripeReviewClient, stripeReviewOverview, stripeReviewStorage } from '../_lib/stripe-reviews.js';

const MAX_BYTES = 8192;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // The SameSite=Strict signed Hub cookie is still required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

// Storage errors keep this subsystem's codes; their dispatch wording is about schedules.
const STORAGE = {
  dispatch_revision_conflict: ['stripe_review_revision_conflict', 409, 'This review or its job changed while it was saving. Refresh the review queue and review it again.'],
  dispatch_outcome_unknown: ['stripe_review_outcome_unknown', 503, 'The save could not be confirmed. Retry the same request to safely check whether it saved.'],
};
function failure(error) {
  const code = String(error?.code || ''), mapped = STORAGE[code];
  if (mapped) return reply(mapped[1], { ok: false, code: mapped[0], error: mapped[2] });
  if (/^stripe_review_[a-z_]+$/.test(code) || /^dispatch_(sign_in_required|forbidden)$/.test(code)) return reply(error.status || 503, { ok: false, code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (code.startsWith('dispatch_storage_')) return reply(503, { ok: false, code: 'stripe_review_storage_unavailable', error: 'Stripe reviews could not be verified. Retry the same request.' });
  return reply(503, { ok: false, code: 'stripe_review_unavailable', error: 'Stripe reviews could not be loaded. Retry.' });
}

export function stripeReviewHandlers({ session = getHubSession, storage = stripeReviewStorage, now = () => new Date(), stripe = env => stripeReviewClient(env) } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        requireDispatcher(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'stripe_review_invalid_query', error: 'Stripe reviews take no query parameters.' });
        return reply(200, await stripeReviewOverview(storage(env), actor, now(), { checkoutBlock: paymentReviewCheckoutBlockEnabled(env) }));
      } catch (error) {
        if (/^(stripe_review_|dispatch_)/.test(String(error?.code || ''))) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'stripe_review_unavailable', error: 'Stripe reviews could not be loaded. Retry.' });
      }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'stripe_review_origin_forbidden', error: 'Open the Employee Hub to resolve reviews.' });
      try {
        const actor = await session(request, env);
        requireDispatcher(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'stripe_review_json_required', error: 'Review changes must be JSON.' });
        if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413, { ok: false, code: 'stripe_review_request_too_large', error: 'The review request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return reply(413, { ok: false, code: 'stripe_review_request_too_large', error: 'The review request is too large.' });
        let input;
        try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'stripe_review_json_invalid', error: 'The review request was incomplete. Refresh and try again.' }); }
        // Both payment actions check the held charge in Stripe (read-only) before anything is saved.
        return reply(200, await resolveStripeReview(storage(env), actor, input, now().toISOString(), { stripe: ['payment.refund', 'payment.reconcile'].includes(input?.action) ? stripe(env) : null }));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = stripeReviewHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
