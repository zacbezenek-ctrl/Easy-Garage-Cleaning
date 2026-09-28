import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { customerPortalLinkAccount } from '../_lib/customer-portal-revocation.js';
import { businessAccountJob } from '../_lib/portal-invitation.js';
import { readJob, patchJob } from '../_lib/firestore-job.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

export function customerPortalLinkHandler({ now = () => new Date() } = {}) {
  return async ({ request, env }) => {
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
    // A homeowner owner link would bypass the company's member roles.
    if (businessAccountJob(job)) return reply(409, { ok: false, error: 'This job is shared with a business account. Its team opens it from the Business Hub, so no homeowner portal link was created.' });
    // Embed the account's current version and root: this link works until
    // staff next revoke the account's portal links or re-parent the job.
    let account, linkVersion;
    try { ({ account, linkVersion } = await customerPortalLinkAccount(id => readJob(env, id), job)); }
    catch (error) {
      if (error.code === 'CUSTOMER_PORTAL_REVOKE_ACCOUNT_REVIEW' || (error.code?.startsWith('dispatch_lineage_') && error.code !== 'dispatch_lineage_missing')) return reply(409, { ok: false, error: 'This job’s customer account needs review before a portal link can be shared' });
      return reply(503, { ok: false, error: 'The customer account could not be loaded. Retry shortly.' });
    }
    const current = now();
    const token = await createCustomerPortalAccessToken(env, jobId, current.getTime(), linkVersion, account.id);
    const createdAt = current.toISOString();
    await patchJob(env, jobId, { customerPortalEnabled: true, customerPortalLinkCreatedAt: createdAt, customerPortalLinkCreatedBy: session.user, updatedAt: createdAt }, job.__updateTime).catch(() => {});
    const origin = new URL(request.url).origin;
    return reply(200, { ok: true, url: `${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`, customer: job.customer || 'Customer', expiresInDays: 30 });
  };
}

export const onRequestPost = customerPortalLinkHandler();
