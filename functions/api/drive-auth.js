/**
 * EGC Google Drive OAuth helper — Cloudflare Pages Function
 * GET /api/drive-auth
 *
 * ONE-TIME SETUP endpoint to mint the refresh token the photo-upload function
 * needs. Self-disables once GOOGLE_REFRESH_TOKEN is set.
 *
 * Uses the drive.file scope — the app can only see/create files and folders
 * it created itself (the "EGC Job Photos" tree), never the rest of the Drive.
 * That scope is non-sensitive, so no Google app verification is required.
 *
 * Setup (once):
 *  1. console.cloud.google.com → create project → "OAuth consent screen":
 *     External, publish to Production (no verification needed for drive.file).
 *  2. Credentials → Create OAuth client ID → Web application
 *     - Authorized redirect URI: https://easygaragecleaning.com/api/drive-auth
 *  3. Cloudflare Pages env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *  4. Visit https://easygaragecleaning.com/api/drive-auth signed into the EGC
 *     Google account → Approve → copy the refresh token shown.
 *  5. Save as GOOGLE_REFRESH_TOKEN (secret). This endpoint then returns 404.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const page = (title, body) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>
   <body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
   <h2>${title}</h2>${body}</body>`,
  { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  if (env.GOOGLE_REFRESH_TOKEN) return new Response('Not found', { status: 404 });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return page('Drive setup — missing config',
      '<p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Cloudflare Pages env vars first (Google Cloud Console → Credentials), then reload.</p>');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const redirectUri = `${url.origin}/api/drive-auth`;

  if (!code) {
    const auth = `${AUTH_URL}?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
      `&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent`;
    return Response.redirect(auth, 302);
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    return page('Drive setup — exchange failed',
      `<p>Google returned ${resp.status}.</p><pre>${JSON.stringify(data).slice(0, 500)}</pre>
       <p>If there's no refresh_token, remove the app at myaccount.google.com/permissions and retry (prompt=consent needs a fresh grant).</p>`);
  }
  return page('Drive connected — one step left',
    `<p>Copy this refresh token into Cloudflare Pages env as <code>GOOGLE_REFRESH_TOKEN</code> (mark it a secret), then redeploy:</p>
     <pre style="background:#eee;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all">${data.refresh_token}</pre>
     <p>This page disables itself once that variable is set.</p>`);
}
