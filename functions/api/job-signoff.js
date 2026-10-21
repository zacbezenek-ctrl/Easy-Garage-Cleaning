/** Supervisor sign-off on completed jobs (SIGNOFF, functions/_lib/job-signoff.js). The owner and managers read the list
 * and sign off or mark a job Needs follow-up; a crew lead reads their own open supervisor follow-ups. It never gates
 * invoicing, payments or the customer receipt.
 * GET /api/job-signoff => {ok, asOf, window:{start}, rows:[{jobId,date,time,customer (first name and last initial),
 *   service,lead (display name),completedAt,hoursSinceCompleted,hasIssues,openFollowUp,signoff:{status,by,byName,at,
 *   reason}|null,overdue,ownJob}], needed, overdue, flagged, olderUnsigned, staleHours}: two bounded queries (jobs
 *   completed in the last SIGNOFF_LOOKBACK_DAYS days, and jobs needing follow-up) and the roster for names.
 * GET /api/job-signoff?view=mine (any signed-in staff member) => {ok, followUps:[{jobId,date,service,reason,by,at}]}:
 *   the open supervisor follow-ups on jobs the viewer leads (one query).
 * POST {action:'sign_off'|'flag', jobId, requestId (UUID), reason, expected:'none'|'flagged'} =>
 *   {ok, jobId, signoff, followUp:'opened'|'added'|'closed'|null, replayed}. Guarded by the job's revision: a job that
 *   changed since it was read answers 409, and the same requestId again is a safe replay.
 * Errors: {ok:false, code, error}; 400, 401, 403 (job_signoff_forbidden, job_signoff_self), 404, 409, 413, 415, 503. */
import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { assignmentKey, createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { SIGNOFF_FIELDS, SIGNOFF_LOOKBACK_DAYS, SIGNOFF_STALE_HOURS, SIGNOFF_WINDOW_DAYS, leadFollowUps, requireSignoffManager, signoffCommand, signoffList, workerMatcher } from '../_lib/job-signoff.js';

const ID = /^[A-Za-z0-9_-]{1,180}$/;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^job_signoff_/.test(error?.code || '')) return reply(error.status || 400, { ok: false, code: error.code, error: error.message });
  if (error?.code === 'dispatch_revision_conflict') return reply(409, { ok: false, code: 'job_signoff_changed', error: 'This job changed while you were looking at it. Refresh and try again.' });
  return reply(503, { ok: false, code: 'job_signoff_unavailable', error: 'Sign-off could not be checked or saved. Retry in a moment.' });
}
// The viewer's identities once per request (a unique display name counts, as for field access).
async function matcherFor(env, session) {
  const identities = await createJobAssignmentAccess(env, session).identities().catch(() => [session.user]);
  return workerMatcher(session, identities.length ? identities : [session.user]);
}

export function jobSignoffHandlers({ session = getHubSession, dispatch = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env).catch(() => null), params = new URL(request.url).searchParams;
        const view = params.get('view');
        if ([...params.keys()].some(name => name !== 'view') || view !== null && view !== 'mine') throw fail('job_signoff_request_invalid', 'Sign-off takes no query options except view=mine.');
        const store = dispatch(env), asOf = now().toISOString();
        if (view === 'mine') {
          if (!actor || !assignmentKey(actor.user)) throw fail('job_signoff_sign_in_required', 'Sign in to see your follow-ups.', 401);
          return reply(200, { ok: true, asOf, followUps: leadFollowUps(await store.flaggedJobs([...SIGNOFF_FIELDS, 'fieldExecution.attention.status']), await matcherFor(env, actor)) });
        }
        requireSignoffManager(actor, env);
        const since = new Date(Date.parse(asOf) - SIGNOFF_LOOKBACK_DAYS * 86400000).toISOString(), start = new Date(Date.parse(asOf) - SIGNOFF_WINDOW_DAYS * 86400000).toISOString();
        const [recent, flagged, roster, matcher] = await Promise.all([store.completedJobsSince(since, [...SIGNOFF_FIELDS]), store.flaggedJobs([...SIGNOFF_FIELDS]), store.roster().catch(() => []), matcherFor(env, actor)]);
        const names = new Map((Array.isArray(roster) ? roster : []).map(person => [assignmentKey(person?.id), String(person?.name || person?.id || '')]));
        return reply(200, { ok: true, asOf, window: { start }, staleHours: SIGNOFF_STALE_HOURS, ...signoffList([...flagged, ...recent], actor, asOf, { matcher, names, windowStart: start }) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw fail('job_signoff_forbidden', 'Sign off from the Hub.', 403);
        const actor = await session(request, env).catch(() => null); requireSignoffManager(actor, env);
        if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw fail('job_signoff_request_invalid', 'Send JSON.', 415);
        const text = await request.text();
        if (text.length > 8000) throw fail('job_signoff_request_invalid', 'This request is too large.', 413);
        let input; try { input = JSON.parse(text); } catch { throw fail('job_signoff_request_invalid', 'Send JSON.'); }
        if (!input || typeof input !== 'object' || !ID.test(String(input.jobId || ''))) throw fail('job_signoff_request_invalid', 'Choose a job.');
        const store = dispatch(env), job = await store.read('jobs', input.jobId);
        if (!job) throw fail('job_signoff_not_found', 'This job no longer exists.', 404);
        const at = now().toISOString(), result = signoffCommand(job, actor, input, at, await matcherFor(env, actor));
        if (result.replayed) return reply(200, { ok: true, jobId: job.id, signoff: job.supervisorSignoff || null, followUp: null, replayed: true });
        await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch: result.patch }]);
        return reply(200, { ok: true, jobId: job.id, signoff: result.signoff, followUp: result.followUp, replayed: false });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = jobSignoffHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
