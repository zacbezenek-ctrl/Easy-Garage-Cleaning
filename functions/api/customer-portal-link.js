import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { readJob, patchJob } from '../_lib/firestore-job.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Business access required' });
  const raw = await request.text();
  if (raw.length > 4 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const jobId = String(body.job_id || '').trim().slice(0, 120);
  if (!jobId) return reply(400, { ok: false, error: 'Select a job first' });
  const job = await readJob(env, jobId).catch(() => null);
  if (!job) return reply(404, { ok: false, error: 'Job not found' });
  const token = await createCustomerPortalAccessToken(env, jobId);
  const createdAt = new Date().toISOString();
  await patchJob(env, jobId, { customerPortalEnabled: true, customerPortalLinkCreatedAt: createdAt, customerPortalLinkCreatedBy: session.user, updatedAt: createdAt }).catch(() => {});
  const origin = new URL(request.url).origin;
  return reply(200, { ok: true, url: `${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`, customer: job.customer || 'Customer', expiresInDays: 30 });
}
