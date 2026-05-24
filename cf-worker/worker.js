/**
 * Cloudflare Worker — EGC Vercel Proxy
 *
 * Routes these paths to Vercel:
 *   /copilot.html, /api/copilot*
 *   /sop.html, /EGC-Lead-System-SOP.pdf
 *   /employee.html, /employee-crm.js, /employee-crm.css
 *
 * Everything else passes through to the existing Cloudflare origin untouched.
 */

const VERCEL_HOST = 'easy-garage-cleaning.vercel.app';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    const toVercel =
      url.pathname === '/copilot.html' ||
      url.pathname === '/api/copilot' ||
      url.pathname.startsWith('/api/copilot/') ||
      url.pathname === '/sop.html' ||
      url.pathname === '/EGC-Lead-System-SOP.pdf' ||
      url.pathname === '/employee.html' ||
      url.pathname === '/employee-crm.js' ||
      url.pathname === '/employee-crm.css';

    if (toVercel) {
      // Rewrite hostname to Vercel, keep path + query intact
      const vercelUrl = new URL(request.url);
      vercelUrl.hostname = VERCEL_HOST;
      vercelUrl.port = '';
      vercelUrl.protocol = 'https:';

      const headers = new Headers(request.headers);
      headers.set('Host', VERCEL_HOST);
      // Forward the real origin so Vercel CORS allows it
      headers.set('X-Forwarded-Host', url.hostname);

      const proxyReq = new Request(vercelUrl.toString(), {
        method:  request.method,
        headers,
        body:    request.body,
        redirect: 'follow',
      });

      return fetch(proxyReq);
    }

    // All other paths — pass through to existing origin
    return fetch(request);
  },
};
