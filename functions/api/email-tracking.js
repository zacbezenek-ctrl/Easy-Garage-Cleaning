import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createEmailTracking, trackingPixelUrl } from '../_lib/email-tracking.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function clean(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Business access required' });

  const raw = await request.text();
  if (raw.length > 8 * 1024) return reply(413, { ok: false, error: 'Request too large' });

  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const recipient = clean(body.recipient, 320).toLowerCase();
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return reply(400, { ok: false, error: 'Invalid recipient email' });
  }

  try {
    const tracking = await createEmailTracking(env, {
      recipient,
      subject: clean(body.subject, 300),
      messageId: clean(body.message_id, 180),
      campaign: clean(body.campaign, 180),
      contactId: clean(body.contact_id, 180),
      source: clean(body.source || 'manual', 120),
    });
    return reply(200, {
      ok: true,
      token: tracking.token,
      pixel_url: trackingPixelUrl(tracking.token),
      html: `<img src="${trackingPixelUrl(tracking.token)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden">`,
    });
  } catch {
    return reply(503, { ok: false, error: 'Email tracking storage is unavailable' });
  }
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
