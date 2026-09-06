import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { sendAcceptedQuotePortal } from '../_lib/portal-invitation.js';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet() { return reply(405, { ok: false, error: 'Use POST from the EGC Hub' }); }

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Business access required' });
  const raw = await request.text();
  if (raw.length > 4096) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const invitation = await sendAcceptedQuotePortal(env, body?.job_id);
  return reply(200, { ok: true, portalInvitation: invitation });
}
