import { enforceBusinessProjectWrite } from './_lib/business-hub-write-guard.js';
import { gateStaffPage, privateStaffResponse } from './_lib/staff-page-gate.js';
import { BOOKING_SLOTS_MARKER, bookingSlotsPageRequest } from './_lib/booking-slots-flag.js';

// Source trees, tooling and deploy configs sit beside the static site; never serve them.
const PRIVATE_PATH = /^(?:\/(?:auth-verifier|contracts|docs|scripts|tests|egc-platform|functions|tools|\.github|\.claude|node_modules)(?:\/|$)|\/(?:sop|tyler-contract)(?:\.html)?\/?$|\/EGC-Lead-System-SOP\.pdf$|\/(?:package(?:-lock)?\.json|README\.md|firebase(?:\.emulator|\.field-day)?\.json|firestore\.(?:rules|indexes\.json)|pnpm-(?:lock|workspace)\.yaml|\.firebaserc|\.env(?:\.example)?|_[^/]+)(?:$|\/)|\/.*\.py\/?$)/i;

function privatePath(pathname) {
  let path;
  try { path = decodeURIComponent(pathname); } catch { return true; }
  // Test the collapsed, dot-resolved form too, so encoded separators cannot step around a prefix.
  const segments = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return PRIVATE_PATH.test(path) || PRIVATE_PATH.test(`/${segments.join('/')}`);
}

// Google Tag Manager (analytics-loader.js) needs www.googletagmanager.com for its script, beacons and noscript
// iframe; tagmanager.google.com serves Tag Assistant preview mode.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://api.web3forms.com",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://maps.googleapis.com https://www.googletagmanager.com https://tagmanager.google.com https://connect.facebook.net https://www.clarity.ms https://scripts.clarity.ms",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://tagmanager.google.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://api.web3forms.com https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com https://*.clarity.ms https://connect.facebook.net",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://maps.google.com https://www.google.com https://js.stripe.com https://checkout.stripe.com https://www.googletagmanager.com",
  "upgrade-insecure-requests",
].join('; ');

function blockedResponse() {
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Not found</title><body><h1>Not found</h1></body></html>', {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

// EGC_BOOKING_EXPLICIT_SLOTS (SALES-BOOKING): while the flag is on, /book is always fetched whole and served marked
// and without validators, so a browser never revalidates (304) into a copy from the other flag state: turning the
// flag on or off reaches the next page load, with no page regenerated. Off, /book is served exactly as before.
function unconditional(request) {
  const headers = new Headers(request.headers);
  for (const name of ['If-None-Match', 'If-Modified-Since']) headers.delete(name);
  return new Request(request, { headers });
}

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (privatePath(pathname)) return blockedResponse();
  const bookingSlotsPage = bookingSlotsPageRequest(context.env, context.request, pathname);

  // EGC_STAFF_PAGE_GATE=on: staff pages and scripts need a Hub session (staff-paths.js); off leaves every response as before.
  const staffPage = await gateStaffPage(context.request, context.env);
  const upstream = staffPage?.refusal || await enforceBusinessProjectWrite(context.request, context.env) || await (bookingSlotsPage ? context.next(unconditional(context.request)) : context.next());
  const explicit404 = pathname === '/404' || pathname === '/404.html';
  const response = new Response(upstream.body, {
    status: explicit404 ? 404 : upstream.status,
    statusText: explicit404 ? 'Not Found' : upstream.statusText,
    headers: upstream.headers,
  });
  const ownerSetup = /^\/hub-login-setup(?:\.html|\.js)?$/.test(pathname);
  // These responses carry their own stricter CSP (OAuth nonce page, no-script money document), and
  // the relay pages set their own narrower CSP for the one other origin they post to.
  const relayPage = pathname === '/api/gusto-auth' || pathname === '/api/mcp-grant';
  const ownPolicy = relayPage || pathname === '/api/money-document';
  if (!ownPolicy || !response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', ownerSetup
    ? "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
    : CSP);
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Co-Pilot voice input, Hub recordings and the iPad walkthrough recorder (FUN-06) may ask for the microphone; every other page cannot.
  const voiceInput = /^\/copilot(?:\.html)?\/?$/.test(pathname) || /^\/employee(?:\.html)?\/?$/.test(pathname) || /^\/crew\/gameplan(?:\.html)?\/?$/.test(pathname);
  response.headers.set('Permissions-Policy', `camera=(), microphone=${voiceInput ? '(self)' : '()'}, geolocation=(self), payment=(), usb=()`);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', pathname.startsWith('/employee') || pathname.startsWith('/crew/') || pathname.startsWith('/copilot') || pathname.startsWith('/staff-login') ? 'DENY' : 'SAMEORIGIN');
  response.headers.delete('Access-Control-Allow-Origin');
  if (ownerSetup) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
  }
  if (pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  if (ownPolicy) {
    // The MCP approval page may keep same-origin, so its own form POST carries a real Origin; the rest send none.
    const sameOriginApproval = pathname === '/api/mcp-grant' && upstream.headers.get('Referrer-Policy') === 'same-origin';
    response.headers.set('Referrer-Policy', sameOriginApproval ? 'same-origin' : 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
  }
  // Private certificate PDFs keep their handler's sandboxed CSP and never send a referrer.
  if (pathname === '/api/customer-portal-document' || pathname === '/api/portal-documents-admin') {
    if (upstream.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', upstream.headers.get('Content-Security-Policy'));
    response.headers.set('Referrer-Policy', 'no-referrer');
  }
  if (pathname.startsWith('/business-hub') || pathname === '/api/business-hub') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  }
  // Client Login and its link-confirm page: private, uncacheable, same-origin scripts and forms only.
  if (/^\/client-login(?:\.html|\.js|\.css)?\/?$/.test(pathname) || pathname === '/api/customer-login' || pathname === '/api/customer-login-verify') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    // The confirm page's form POST needs a real Origin; strict-origin still never sends its token-bearing URL.
    response.headers.set('Referrer-Policy', pathname === '/api/customer-login-verify' ? 'strict-origin' : 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  }
  if (upstream.status === 404 || explicit404) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  if (staffPage) privateStaffResponse(response);
  // Refresh a formerly immutable shared script URL and add a discoverable
  // business entry in server-rendered navigation, even with JavaScript disabled.
  if (response.status === 200 && response.headers.get('Content-Type')?.includes('text/html') && typeof HTMLRewriter !== 'undefined') {
    const rewriter = new HTMLRewriter()
      .on('script[src^="/site-enhancements.js"]', { element(el) { el.setAttribute('src', '/site-enhancements.js?v=20260923business'); } })
      .on('nav.nav .nav-links', { element(el) { el.setAttribute('style', 'flex-wrap:wrap;gap:8px 14px'); el.append('<li><a href="/business-hub">Business Hub</a></li>', { html: true }); } })
      .on('#nav-drawer .drawer-cta', { element(el) { el.before('<a href="/business-hub" class="drawer-link-row">Business Client Hub</a>', { html: true }); } });
    // EGC_BOOKING_EXPLICIT_SLOTS on: tell booking-slots.js to render /book's windows. Unmarked, the page keeps its static choices.
    if (bookingSlotsPage) {
      response.headers.delete('ETag');
      response.headers.delete('Last-Modified');
      rewriter.on('fieldset.booking-slots', { element(el) { el.setAttribute(BOOKING_SLOTS_MARKER, ''); } });
    }
    return rewriter.transform(response);
  }
  return response;
}
