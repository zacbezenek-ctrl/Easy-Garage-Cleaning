/**
 * GUARD-SELL — GET /api/garage-guard-link?s=cs_…&k=… : the short Garage Guard sign-up link a staff member's device shows
 * as a QR code (and copies or texts). Public: the customer opens it on their own phone, signed out.
 *
 * k is the server's signature over the session id (garage-guard-sales.js guardLinkSignature), so this route asks Stripe
 * only about sessions /api/garage-guard-sell opened; anything else is a plain 404 page without a Stripe call. An open
 * sign-up redirects to its Stripe Checkout page; a finished one to the public page's thank-you; an expired one to the
 * public plans. The session's contents (who sold it, the customer) are never shown.
 */
import { guardLinkValid, guardSaleFromMetadata, guardSessionId, readGuardCheckout } from '../_lib/garage-guard-sales.js';

const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com';
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };

function page(status, title, text) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title>`
    + '<style>body{margin:0;font:17px/1.5 system-ui,sans-serif;background:#f2e9dc;color:#13203a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:420px}h1{font-size:24px;margin:0 0 8px}a{display:inline-block;margin-top:14px;background:#e8581c;color:#fff;text-decoration:none;font-weight:700;padding:13px 18px;border-radius:10px;min-height:44px;box-sizing:border-box}</style></head>'
    + `<body><main><h1>${title}</h1><p>${text}</p><a href="/garage-guard.html#plans">See Garage Guard plans</a></main></body></html>`;
  return new Response(body, { status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}
const redirect = location => new Response(null, { status: 303, headers: { ...HEADERS, Location: location } });

export function garageGuardLinkHandlers({ fetcher = (...args) => fetch(...args) } = {}) {
  return {
    async get({ request, env }) {
      const params = new URL(request.url).searchParams, sessionId = guardSessionId(params.get('s'));
      const missing = () => page(404, 'This sign-up link is not valid', 'Ask your Easy Garage Cleaning team member to show you a new code, or choose a plan on our Garage Guard page.');
      if (!sessionId || !await guardLinkValid(env, sessionId, params.get('k'))) return missing();
      let checkout;
      try { checkout = await readGuardCheckout(env, sessionId, { fetcher }); }
      catch (error) {
        if (error?.code === 'guard_sales_session_missing') return missing();
        return page(503, 'Please try again in a moment', 'We could not reach our payment provider just now. Scan the code again in a minute.');
      }
      if (!guardSaleFromMetadata(checkout.metadata)) return missing();
      if (checkout.status === 'complete') return redirect('/garage-guard.html?checkout=success');
      if (checkout.status === 'open' && typeof checkout.url === 'string') {
        let target;
        try { target = new URL(checkout.url); } catch { target = null; }
        if (target?.protocol === 'https:' && target.hostname === STRIPE_CHECKOUT_HOST) return redirect(target.href);
      }
      return page(410, 'This sign-up link has expired', 'Ask your Easy Garage Cleaning team member for a new code, or choose a plan on our Garage Guard page.');
    },
  };
}

const handlers = garageGuardLinkHandlers();
export const onRequestGet = handlers.get;
