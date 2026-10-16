import { getHubSession } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { fieldId, fieldRequestId } from '../_lib/field-execution.js';
import { prepareW19Handoff, readW19Handoff, w19AssignedLead, w19Enabled } from '../_lib/w19-completion-handoff.js';
import { w19Error, w19OriginAllowed, w19ReadBody, w19Reply } from '../_lib/w19-http.js';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export function fieldCompletionHandoffHandlers({ session = getHubSession, storage = dispatchStorage, configured = firebaseServiceAccountConfigured, now = () => new Date() } = {}) {
  async function context(request, env) {
    if (!w19Enabled(env)) throw fail('W19_DISABLED', 'Completion confirmation is not enabled.', 404);
    const actor = await session(request, env);
    if (!actor) throw fail('W19_AUTH_REQUIRED', 'Sign in to the Employee Hub to confirm completion.', 401);
    if (!configured(env)) throw fail('W19_STORAGE_UNAVAILABLE', 'Secure job storage is unavailable.', 503);
    return { actor, store: storage(env) };
  }
  async function authorized(ctx, env, id) {
    if (!fieldId(id)) throw fail('W19_JOB_INVALID', 'Choose one canonical job.');
    const job = await ctx.store.read('jobs', id);
    if (!job || !['job', 'cleanout', 'reorg'].includes(job.type) || job.recordType) throw fail('W19_JOB_NOT_FOUND', 'The job is unavailable.', 404);
    if (!await w19AssignedLead(env, ctx.actor, job)) throw fail('W19_LEAD_REQUIRED', 'Only the currently assigned job lead can confirm completion.', 403);
    return job;
  }
  async function get({ request, env }) {
    try {
      const ctx = await context(request, env), params = [...new URL(request.url).searchParams];
      if (params.length !== 1 || params[0][0] !== 'jobId') throw fail('W19_JOB_INVALID', 'Choose one canonical job.');
      const job = await authorized(ctx, env, params[0][1]);
      return w19Reply(200, await readW19Handoff(env, ctx.store, job, ctx.actor, now().toISOString()));
    } catch (error) { return w19Error(error); }
  }
  async function post({ request, env }) {
    try {
      if (!w19OriginAllowed(request)) throw fail('W19_ORIGIN_FORBIDDEN', 'Open completion confirmation from the Employee Hub.', 403);
      const ctx = await context(request, env), input = await w19ReadBody(request, ['action', 'jobId', 'requestId', 'expectedRevision', 'expectedUser']);
      if (input.action !== 'prepare' || !fieldId(input.jobId) || !fieldRequestId(input.requestId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80) throw fail('W19_REQUEST_INVALID', 'Use the current job version and a unique action ID.');
      if (typeof input.expectedUser !== 'string' || input.expectedUser.toLowerCase() !== ctx.actor.user.toLowerCase()) throw fail('W19_ACCOUNT_CHANGED', 'Your signed-in account changed. Refresh before confirming completion.', 401);
      const job = await authorized(ctx, env, input.jobId);
      return w19Reply(200, await prepareW19Handoff(env, ctx.store, job, ctx.actor, input, now().toISOString()));
    } catch (error) { return w19Error(error); }
  }
  return { get, post };
}
const handlers = fieldCompletionHandoffHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
