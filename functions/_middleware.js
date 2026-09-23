const PRIVATE_PATH = /^(?:\/(?:auth-verifier|contracts|docs|scripts|tests)(?:\/|$)|\/(?:sop|tyler-contract)(?:\.html)?\/?$|\/EGC-Lead-System-SOP\.pdf$|\/(?:package(?:-lock)?\.json|README\.md|firebase\.json|firestore\.rules|\.firebaserc|\.env(?:\.example)?|_[^/]+)(?:$|\/))/i;

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://api.web3forms.com",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://maps.googleapis.com https://www.googletagmanager.com https://connect.facebook.net https://www.clarity.ms https://scripts.clarity.ms",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://api.web3forms.com https://www.google-analytics.com https://region1.google-analytics.com https://*.clarity.ms https://connect.facebook.net",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://maps.google.com https://www.google.com https://js.stripe.com https://checkout.stripe.com",
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

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (PRIVATE_PATH.test(decodeURIComponent(pathname))) return blockedResponse();

  const upstream = await context.next();
  const explicit404 = pathname === '/404' || pathname === '/404.html';
  const response = new Response(upstream.body, {
    status: explicit404 ? 404 : upstream.status,
    statusText: explicit404 ? 'Not Found' : upstream.statusText,
    headers: upstream.headers,
  });
  const ownerSetup = /^\/hub-login-setup(?:\.html|\.js)?$/.test(pathname);
  const gustoAuth = pathname === '/api/gusto-auth';
  if (!gustoAuth || !response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', ownerSetup
    ? "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
    : CSP);
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const voiceInput = /^\/copilot(?:\.html)?\/?$/.test(pathname);
  response.headers.set('Permissions-Policy', `camera=(), microphone=${voiceInput ? '(self)' : '()'}, geolocation=(self), payment=(), usb=()`);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', pathname.startsWith('/employee') || pathname.startsWith('/crew/') || pathname.startsWith('/copilot') ? 'DENY' : 'SAMEORIGIN');
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
  if (gustoAuth) {
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
  }
  if (pathname.startsWith('/business-hub') || pathname === '/api/business-hub') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  }
  if (upstream.status === 404 || explicit404) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  // Refresh a formerly immutable shared script URL and add a discoverable
  // business entry in server-rendered navigation, even with JavaScript disabled.
  if (response.status === 200 && response.headers.get('Content-Type')?.includes('text/html') && typeof HTMLRewriter !== 'undefined') {
    return new HTMLRewriter()
      .on('script[src^="/site-enhancements.js"]', { element(el) { el.setAttribute('src', '/site-enhancements.js?v=20260923business'); } })
      .on('nav.nav .nav-links', { element(el) { el.append('<li><a href="/business-hub">Business Hub</a></li>', { html: true }); } })
      .on('#nav-drawer .drawer-cta', { element(el) { el.before('<a href="/business-hub" class="drawer-link-row">Business Client Hub</a>', { html: true }); } })
      .transform(response);
  }
  return response;
}
