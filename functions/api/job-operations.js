import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { dispatchOverview } from '../_lib/dispatch-service.js';
import { dispatchSearch } from '../_lib/dispatch-search.js';
import { dispatchOpenings } from '../_lib/dispatch-openings.js';
import { dispatchTravelRoutes, travelEstimator } from '../_lib/dispatch-travel.js';
import { jobOperationsAuthorize, mutateJobOperation, operationalJob, projectOperationalResult, requireJobOperations } from '../_lib/job-operations.js';
import { stripCrewMoneyDeep } from '../_lib/crew-money.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'dispatch_job_operations_invalid' });
const errorReply = error => reply(error.status || 503, { ok: false, code: error.code || 'dispatch_unavailable', error: error.code ? stripCrewMoneyDeep(error.message) : 'Job operations are unavailable. Refresh before retrying.' });
const keys = (value, allowed) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('Unsupported job view or filter.'); };

export function jobOperationsHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date(), travel = travelEstimator } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireJobOperations(actor, env);
        const params = new URL(request.url).searchParams;
        if (new Set(params.keys()).size !== [...params.keys()].length) throw fail('Each filter can be supplied once.');
        const { view = 'board', ...query } = Object.fromEntries(params), store = storage(env), authorize = jobOperationsAuthorize(env);
        const options = { authorize, travel: travel({ env, store, now }) };
        let result;
        if (view === 'search') result = await dispatchSearch({ ...store, jobs: async () => (await store.jobs()).filter(operationalJob) }, actor, query, now(), options);
        else if (view === 'openings') {
          if (query.kind && query.kind !== 'job') throw fail('Only service jobs are available.');
          result = await dispatchOpenings(store, actor, { ...query, kind: 'job' }, now(), options);
          return reply(200, stripCrewMoneyDeep({ ...pick(result, ['ok', 'timeZone', 'startDate', 'endDate', 'total', 'truncated', 'coverage']), candidates: result.candidates.map(row => pick(row, ['date', 'time', 'endDate', 'endTime', 'employeeIds', 'crewId', 'crewName', 'vehicleId', 'durationMinutes'])) }));
        } else if (view === 'travel') {
          result = await dispatchTravelRoutes(store, actor, query, now(), options);
          return reply(200, stripCrewMoneyDeep({ ...pick(result, ['ok', 'timeZone', 'date', 'coverage']), employees: result.employees.map(row => ({ ...pick(row, ['employeeId', 'name', 'active', 'complete']), jobs: row.jobs.filter(operationalJob).map(job => pick(job, ['id', 'customer', 'address', 'date', 'time', 'endDate', 'endTime'])), legs: row.legs.map(leg => pick(leg, ['fromJobId', 'toJobId', 'estimatedMinutes', 'requiredMinutes', 'shortByMinutes', 'status'])) })) }));
        } else {
          if (!['board', 'job', 'customers'].includes(view)) throw fail('Unsupported job view.');
          keys(query, view === 'job' ? ['jobId'] : view === 'customers' ? ['q'] : ['startDate', 'endDate', 'includeUnscheduled']);
          result = await dispatchOverview(store, actor, { ...query, ...(view === 'board' ? {} : { view }) }, now(), options);
          if (result.job && !operationalJob(result.job)) throw fail('Only operational jobs are available.', 403);
        }
        return reply(200, { ...projectOperationalResult(result), viewer: { id: actor.user, jobOperations: true } });
      } catch (error) { return errorReply(error); }
    },
    async post({ request, env }) {
      try {
        const origin = request.headers.get('Origin') || request.headers.get('Referer');
        if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || origin && new URL(origin).origin !== new URL(request.url).origin) throw fail('Use the signed-in job operations page.', 403);
        const actor = await session(request, env); requireJobOperations(actor, env);
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('Use JSON for job changes.', 415);
        if (Number(request.headers.get('Content-Length')) > 64000) throw fail('Request too large.', 413);
        if (!request.body) throw fail('A job change is required.');
        const reader = request.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 64000) { await reader.cancel(); throw fail('Request too large.', 413); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const raw = new TextDecoder().decode(bytes);
        let input; try { input = JSON.parse(raw); } catch { throw fail('Invalid JSON.'); }
        const store = storage(env);
        return reply(200, await mutateJobOperation(store, actor, input, now().toISOString(), env, { travel: travel({ env, store, now, googleLimit: 0, cacheWrites: false }) }));
      } catch (error) { return errorReply(error); }
    },
  };
}
const handlers = jobOperationsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
