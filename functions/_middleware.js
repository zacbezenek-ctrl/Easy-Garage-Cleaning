const PRIVATE_PATH = /^(?:\/(?:contracts|docs|scripts|tests)(?:\/|$)|\/(?:sop|tyler-contract)(?:\.html)?\/?$|\/EGC-Lead-System-SOP\.pdf$|\/(?:package(?:-lock)?\.json|README\.md|firebase\.json|firestore\.rules|\.firebaserc|\.env(?:\.example)?|_[^/]+)(?:$|\/))/i;

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
  response.headers.set('Content-Security-Policy', CSP);
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(), usb=()');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', pathname.startsWith('/employee') || pathname.startsWith('/crew/') || pathname.startsWith('/copilot') ? 'DENY' : 'SAMEORIGIN');
  response.headers.delete('Access-Control-Allow-Origin');
  if (pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  if (upstream.status === 404 || explicit404) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
}
