import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { createCustomerPortalAccessToken } from '../_lib/customer-portal.js';
import { customerPortalLinkAccount } from '../_lib/customer-portal-revocation.js';
import { businessAccountJob } from '../_lib/portal-invitation.js';
import { readJob, patchJob } from '../_lib/firestore-job.js';
import { requireQuoteAuthor } from '../_lib/quote-permissions.js';
import { assignmentKey, createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { walkthroughEstimator } from '../_lib/highlevel-users.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The audit trail kept on the job: who copied a private link, and when (the newest COPY_AUDIT_LIMIT).
export const COPY_AUDIT_LIMIT = 20;

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

/** PORTAL-LINKS (D): the estimator who owns this customer's quote may copy its private portal link from the quote's
 * send screen or saved-quote view: the author of the quote job (job.createdBy, the quote draft's createdBy) or the
 * estimator of its source walkthrough (the visit's crew lead or assigned person, or who started the visit). Nobody
 * else's. */
export async function estimatorOwnsJob(env, actor, job, { read = id => readJob(env, id), assignments = createJobAssignmentAccess(env, actor) } = {}) {
  const user = assignmentKey(actor?.user);
  if (!user || !job) return false;
  const own = value => typeof value === 'string' && assignmentKey(value) === user;
  if (own(job.createdBy) || own(job.quoteDraft?.createdBy)) return true;
  if (typeof job.sourceWalkthroughId !== 'string' || !job.sourceWalkthroughId) return false;
  const visit = await read(job.sourceWalkthroughId).catch(() => null);
  if (!visit || visit.type !== 'walkthrough' || visit.recordType || job.customerId && visit.customerId && visit.customerId !== job.customerId) return false;
  return own(walkthroughEstimator(visit)) || own(visit.walkthroughVisit?.startedBy) || await assignments.assigned(visit).catch(() => false);
}

// The audit is part of an estimator's copy: no record, no link. A business user's copy keeps today's best effort.
async function recordCopy(env, jobId, job, entry, required) {
  let current = job;
  for (let round = 0; round < 3; round += 1) {
    try {
      const copies = [...(Array.isArray(current.portalLinkCopies) ? current.portalLinkCopies.filter(plain) : []), entry].slice(-COPY_AUDIT_LIMIT);
      await patchJob(env, jobId, { customerPortalEnabled: true, customerPortalLinkCreatedAt: entry.at, customerPortalLinkCreatedBy: entry.by, portalLinkCopies: copies, updatedAt: entry.at }, current.__updateTime);
      return true;
    } catch {
      if (!required) return false;
      current = await readJob(env, jobId).catch(() => null);
      if (!current?.__updateTime) return false;
    }
  }
  return false;
}

export function customerPortalLinkHandler({ now = () => new Date(), session: sessionOf = getHubSession } = {}) {
  return async ({ request, env }) => {
    if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
    const session = await sessionOf(request, env);
    if (!session) return reply(401, { ok: false, error: 'Sign in to the EGC Hub' });
    const business = hasBusinessAccess(session);
    if (!business) {
      try { requireQuoteAuthor(session, env); } catch { return reply(403, { ok: false, error: 'Business access required' }); }
    }
    const raw = await request.text();
    if (raw.length > 4 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
    const jobId = String(body.job_id || '').trim().slice(0, 120);
    if (!jobId) return reply(400, { ok: false, error: 'Select a job first' });
    const job = await readJob(env, jobId).catch(() => null);
    if (!job) return reply(404, { ok: false, error: 'Job not found' });
    if (!business && !await estimatorOwnsJob(env, session, job)) return reply(403, { ok: false, code: 'PORTAL_LINK_NOT_YOURS', error: 'Only the estimator who owns this quote, or the office, can copy this customer’s portal link.' });
    // A homeowner owner link would bypass the company's member roles: a business-linked job, or a visit Dispatch created
    // under one (it carries only customerAccountOwnerJobId, so its account root is checked once resolved, below).
    const businessShared = () => reply(409, { ok: false, error: 'This job is shared with a business account. Its team opens it from the Business Hub, so no homeowner portal link was created.' });
    if (businessAccountJob(job)) return businessShared();
    // Embed the account's current version and root: this link works until
    // staff next revoke the account's portal links or re-parent the job.
    let account, linkVersion;
    try { ({ account, linkVersion } = await customerPortalLinkAccount(id => readJob(env, id), job)); }
    catch (error) {
      if (error.code === 'CUSTOMER_PORTAL_REVOKE_ACCOUNT_REVIEW' || (error.code?.startsWith('dispatch_lineage_') && error.code !== 'dispatch_lineage_missing')) return reply(409, { ok: false, error: 'This job’s customer account needs review before a portal link can be shared' });
      return reply(503, { ok: false, error: 'The customer account could not be loaded. Retry shortly.' });
    }
    if (businessAccountJob(account)) return businessShared();
    const current = now();
    const createdAt = current.toISOString();
    const recorded = await recordCopy(env, jobId, job, { by: session.user, at: createdAt, role: business ? 'office' : 'estimator' }, !business);
    if (!business && !recorded) return reply(503, { ok: false, error: 'The copy could not be recorded on the job, so no link was created. Retry shortly.' });
    const token = await createCustomerPortalAccessToken(env, jobId, current.getTime(), linkVersion, account.id);
    const origin = new URL(request.url).origin;
    return reply(200, { ok: true, url: `${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`, customer: job.customer || 'Customer', expiresInDays: 30 });
  };
}

export const onRequestPost = customerPortalLinkHandler();
