/* The Client Login link. GET only renders a confirm page (no storage access),
   so link scanners and previews never spend the token. The page's form POST
   chooses the landing project, then consumes the token, opens an account
   session (__Host-egc_customer) and hands the customer to that project through
   the existing per-job portal session, and answers 303. If anything before the
   commit fails, the link is left unspent and a 503 page offers the same tap
   again. The page works without script; client-login.js only stops a double
   tap from spending the link twice. Off unless CUSTOMER_LOGIN_ENABLED. */
import { customerAccountStorage, readCustomerAccountContext } from '../_lib/customer-account-access.js';
import { customerLoginEnabled, loginTokenValid, redeemLoginLink } from '../_lib/customer-magic-link.js';
import { clearCustomerPortalSessionCookie, createCustomerPortalSessionCookie } from '../_lib/customer-portal.js';

const MAX_BYTES = 1024;
const STATUS = { CUSTOMER_LOGIN_LINK_INVALID: 'invalid', CUSTOMER_LOGIN_LINK_USED: 'used', CUSTOMER_LOGIN_LINK_EXPIRED: 'expired', CUSTOMER_LOGIN_LINK_REVOKED: 'expired', CUSTOMER_LOGIN_LINK_CHANGED: 'retry' };
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
// strict-origin, not no-referrer: a form POST under no-referrer carries `Origin: null`,
// and the token in this page's URL must never travel in a Referer.
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };

function page(status, title, body) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="strict-origin">
<title>${escape(title)} · Easy Garage Cleaning</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/client-login.css?v=20260928b">
<script src="/client-login.js?v=20260928b" defer></script>
</head>
<body>
<main class="cl-shell">
<p class="cl-brand"><img src="/images/brand/egc-icon-64.png" alt="" width="32" height="32"><span>Easy Garage Cleaning</span></p>
<section class="cl-card">
${body}
</section>
</main>
</body>
</html>
`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...HEADERS } });
}

const notFound = () => page(404, 'Not found', '<h1>Page not found</h1>\n<p class="cl-lead">Client Login is not available right now. Text us for a secure link.</p>\n<a class="cl-button" href="sms:+19709991818">Text (970) 999-1818</a>');
const redirect = (location, cookies = []) => {
  const headers = new Headers({ Location: location, ...HEADERS });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
};

const confirmForm = (token, label) => `<form id="cl-confirm" class="cl-form" method="post" action="/api/customer-login-verify">
<input type="hidden" name="token" value="${escape(token)}">
<button class="cl-button" type="submit">${label}</button>
</form>`;

export function confirmPage(token) {
  return page(200, 'Finish signing in', `<h1>Finish signing in</h1>
<p class="cl-lead">Tap the button to open your projects on this device. This link works once and expires 15 minutes after we sent it.</p>
${confirmForm(token, 'Sign in to my projects')}
<p class="cl-note">Didn’t ask for this? Close this page; nothing happens until you tap the button.</p>
<a class="cl-button secondary cl-spaced" href="/client-login">Request a new link</a>`);
}

// The sign-in did not commit (or its outcome is unknown): the same link may be tapped again.
export function retryPage(token) {
  return page(503, 'Finish signing in', `<h1>Sign-in didn’t finish</h1>
<p class="cl-lead">We couldn’t open your projects just now. Your link still works until it expires: tap the button to try again.</p>
${confirmForm(token, 'Try again')}
<a class="cl-button secondary cl-spaced" href="/client-login">Request a new link</a>`);
}

// A form POST from the confirm page carries this exact Origin. A browser that
// still reports `null` is accepted only when it also proves a same-origin fetch.
function sameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site'), origin = request.headers.get('Origin');
  if (site === 'cross-site') return false;
  if (origin === 'null') return site === 'same-origin';
  try { return origin === new URL(request.url).origin; } catch { return false; }
}

export function customerLoginVerifyHandlers({ storage = env => customerAccountStorage(env), now = () => new Date(), random = bytes => crypto.getRandomValues(bytes) } = {}) {
  return {
    async get({ request, env }) {
      if (!customerLoginEnabled(env)) return notFound();
      // Exactly one well-formed token; anything a mail or SMS tracker appends (utm_* and the like) is never read.
      const tokens = new URL(request.url).searchParams.getAll('token');
      if (tokens.length !== 1 || !loginTokenValid(tokens[0])) return redirect('/client-login?status=invalid');
      return confirmPage(tokens[0]);
    },
    async post({ request, env }) {
      if (!customerLoginEnabled(env)) return notFound();
      if (!sameOrigin(request)) return page(403, 'Sign-in blocked', '<h1>Sign-in blocked</h1>\n<p class="cl-lead">Open the sign-in link from your text or email again.</p>\n<a class="cl-button secondary" href="/client-login">Request a new link</a>');
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' || Number(request.headers.get('Content-Length')) > MAX_BYTES) return redirect('/client-login?status=invalid');
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return redirect('/client-login?status=invalid');
      const form = new URLSearchParams(raw);
      if ([...form.keys()].some(key => key !== 'token') || form.getAll('token').length !== 1) return redirect('/client-login?status=invalid');
      const store = storage(env), at = now(), token = form.get('token');
      // The landing project and its cookie are settled before the link is spent: a
      // failed read leaves the link unused (and any existing portal cookie untouched).
      const landingCookie = async customer => {
        const { landing } = await readCustomerAccountContext(store, { customerId: customer.id }, { now: at });
        return landing ? createCustomerPortalSessionCookie(env, landing.jobId, { linkVersion: landing.linkVersion, linkRoot: landing.linkRoot }, at.getTime()) : '';
      };
      let signedIn;
      try { signedIn = await redeemLoginLink(store, env, token, at.toISOString(), { random, prepare: landingCookie }); }
      catch (error) { return STATUS[error?.code] || !loginTokenValid(token) ? redirect(`/client-login?status=${STATUS[error?.code] || 'invalid'}`) : retryPage(token); }
      // No project to open (none active, or only Business Hub projects): any per-job
      // portal cookie left by an earlier sign-in on this browser is cleared.
      const project = signedIn.prepared || '';
      return redirect(project ? '/customer-portal' : '/client-login?status=signed_in', [signedIn.session.cookie, project || clearCustomerPortalSessionCookie()]);
    },
  };
}

const handlers = customerLoginVerifyHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
