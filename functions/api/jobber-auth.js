/**
 * EGC Jobber OAuth helper — Cloudflare Pages Function
 * GET /api/jobber-auth
 *
 * ONE-TIME SETUP endpoint to mint the refresh token the customer-lookup
 * function needs. Self-disables once JOBBER_REFRESH_TOKEN is set.
 *
 * Setup (once):
 *  1. developer.getjobber.com → Create app
 *     - Redirect URI: https://easygaragecleaning.com/api/jobber-auth
 *     - Scopes: read_clients (read only)
 *     - Refresh Token Rotation: OFF (token lives in an env var; rotation would orphan it)
 *  2. Cloudflare Pages → Settings → Environment variables:
 *     JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET
 *  3. Visit https://easygaragecleaning.com/api/jobber-auth while logged into
 *     the EGC Jobber account → Approve → copy the refresh token shown.
 *  4. Save it as JOBBER_REFRESH_TOKEN (secret). This endpoint then returns 404.
 */

const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize';

const page = (title, body) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>
   <body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
   <h2>${title}</h2>${body}</body>`,
  { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  // Self-disable after setup — once the refresh token exists this endpoint is unnecessary surface.
  if (env.JOBBER_REFRESH_TOKEN) return new Response('Not found', { status: 404 });
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET) {
    return page('Jobber setup — missing config',
      '<p>Set <code>JOBBER_CLIENT_ID</code> and <code>JOBBER_CLIENT_SECRET</code> in Cloudflare Pages env vars first (from developer.getjobber.com), then reload.</p>');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const redirectUri = `${url.origin}/api/jobber-auth`;

  if (!code) {
    const auth = `${AUTH_URL}?client_id=${encodeURIComponent(env.JOBBER_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=egc`;
    return Response.redirect(auth, 302);
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    return page('Jobber setup — exchange failed',
      `<p>Jobber returned ${resp.status}.</p><pre>${JSON.stringify(data).slice(0, 500)}</pre>
       <p>Check the redirect URI matches exactly, then retry.</p>`);
  }
  return page('Jobber connected — one step left',
    `<p>Copy this refresh token into Cloudflare Pages env as <code>JOBBER_REFRESH_TOKEN</code> (mark it a secret), then redeploy:</p>
     <pre style="background:#eee;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all">${data.refresh_token}</pre>
     <p>This page disables itself once that variable is set. Keep Refresh Token Rotation OFF in the Jobber app settings.</p>`);
}
