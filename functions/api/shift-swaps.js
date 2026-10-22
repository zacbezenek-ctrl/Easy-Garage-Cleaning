/** Shift-swap requests (SHIFT-SWAP, functions/_lib/shift-swaps.js). Any signed-in staff member reads their own swaps and
 * the jobs they could hand over; managers and the owner also read the swaps waiting for approval.
 * GET /api/shift-swaps => {ok, asOf, mine:[swap], incoming:[swap], jobs:[{id,date,time,service}], coworkers:[{id,name}],
 *   canApprove, approvals:[swap with canDecide, newLead] (managers only)}. Swaps closed more than SWAP_WINDOW_DAYS ago
 *   are left out. Open swaps show the live job's date and time; one whose job has started, was rescheduled or is gone
 *   is saved as expired here (best effort), not only shown so.
 * POST {action:'request', requestId, jobId, to, reason} | {action:'accept'|'decline'|'cancel'|'deny', swapId, note} |
 *   {action:'approve', swapId} => {ok, swap, replayed}. Approve saves 'approving', then runs dispatch's schedule.update
 *   for the job (the requester out, the coworker in), so every dispatch rule and crew notification applies; a dispatch
 *   refusal (dispatch_conflict and the rest) comes back as is and the swap goes back to accepted.
 * Errors: {ok:false, code, error, details?}; 400, 401, 403, 404, 409, 413, 415, 503 retry. */
import { getHubSession, isHubOwner } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { mutateDispatch } from '../_lib/dispatch-service.js';
import { travelEstimator } from '../_lib/dispatch-travel.js';
import { denverWorkDate } from '../_lib/timesheet-week.js';
import { addDays } from '../_lib/dispatch-time.js';
import { assignmentKey } from '../_lib/job-assignment.js';
import { RESCHEDULED as RESCHEDULED_TEXT, SWAP_EXPIRES, SWAP_FIELDS, SWAP_JOB_FIELDS, SWAP_OPEN, SWAP_WINDOW_DAYS, answerSwap, expireSwap, jobStart, requestSwap, requireApprover, requireSwapSession, swapBlocker, swapDispatchChanges, swapDispatchRequestId, swapLockId, swapManager, swapRescheduled, swapSchedule, swapView } from '../_lib/shift-swaps.js';

const SWAP_ID = /^swap_[0-9a-f]{32}$/;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^shift_swap_/.test(error?.code || '')) return reply(error.status || 400, { ok: false, code: error.code, error: error.message });
  if (error?.code === 'dispatch_revision_conflict') return reply(409, { ok: false, code: 'shift_swap_changed', error: 'This changed while you were looking at it. Refresh and try again.' });
  if (/^dispatch_/.test(error?.code || '') && error.status && error.status < 500) return reply(error.status, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'shift_swap_unavailable', error: 'Shift swaps could not be checked or saved. Retry in a moment.' });
}
const strip = row => { const { revision, ...rest } = row || {}; return rest; };
const recent = (swap, nowMs) => SWAP_OPEN.includes(swap.status) || Date.parse(swap.updatedAt || '') >= nowMs - SWAP_WINDOW_DAYS * 86400000;
const GONE = 'This job no longer exists.';
/** Why an open swap has closed on its own against the live job ('' while it still stands). */
const lapsed = (swap, job, nowMs) => !job ? GONE : jobStart(job) !== null && jobStart(job) <= nowMs ? 'The job started first.' : swapRescheduled(swap, job);
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id));

export function shiftSwapHandlers({ session = getHubSession, dispatch = dispatchStorage, travel = travelEstimator, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env).catch(() => null); requireSwapSession(actor);
        if ([...new URL(request.url).searchParams.keys()].length) throw fail('shift_swap_request_invalid', 'Shift swaps take no query options.');
        const asOf = now().toISOString(), nowMs = Date.parse(asOf), today = denverWorkDate(asOf), me = assignmentKey(actor.user), store = dispatch(env), manager = swapManager(actor, env);
        const [mine, incoming, jobs, roster, open] = await Promise.all([
          store.shiftSwaps({ field: 'from', op: 'EQUAL', value: me }, [...SWAP_FIELDS]), store.shiftSwaps({ field: 'to', op: 'EQUAL', value: me }, [...SWAP_FIELDS]),
          store.datedJobs(today, addDays(today, SWAP_WINDOW_DAYS), [...SWAP_JOB_FIELDS]), store.roster(),
          manager ? store.shiftSwaps({ field: 'status', op: 'IN', value: [...SWAP_OPEN] }, [...SWAP_FIELDS]) : [],
        ]);
        // The live jobs behind the open swaps: their date, time and start count, and a lapsed swap is saved as expired.
        const swaps = new Map([...mine, ...incoming, ...open].map(swap => [swap.id, swap]));
        const openJobs = [...new Set([...swaps.values()].filter(swap => SWAP_OPEN.includes(swap.status)).map(swap => swap.jobId).filter(id => /^[A-Za-z0-9_-]{1,180}$/.test(String(id || ''))))];
        const live = new Map((await store.readMany('jobs', openJobs, [...SWAP_JOB_FIELDS])).map(job => [job.id, job]));
        const closing = [...swaps.values()].filter(swap => SWAP_EXPIRES.includes(swap.status)).map(swap => [swap, lapsed(swap, live.get(swap.jobId), nowMs)]).filter(([, why]) => why);
        await Promise.allSettled(closing.map(async ([swap, why]) => {
          const next = expireSwap(swap, asOf, why);
          await store.commit([{ collection: 'shiftSwaps', id: swap.id, revision: swap.revision, patch: strip(next) }]);
          swaps.set(swap.id, next);
        }));
        const latest = list => list.map(swap => swaps.get(swap.id) || swap);
        const view = list => latest(list).filter(swap => recent(swap, nowMs)).map(swap => swapView(swap, nowMs, SWAP_OPEN.includes(swap.status) ? live.get(swap.jobId) : null)).sort(byNewest);
        const swappable = jobs.filter(job => (Array.isArray(job.assignedCrew) ? job.assignedCrew : []).some(person => assignmentKey(person) === me) && !swapBlocker(job, nowMs))
          .map(job => ({ id: job.id, date: job.date, time: job.time, service: String(job.serviceType || job.title || 'Job') })).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
        const coworkers = roster.filter(person => assignmentKey(person.id) && assignmentKey(person.id) !== me).map(person => ({ id: person.id, name: String(person.name || person.id) })).sort((a, b) => a.name.localeCompare(b.name));
        const names = new Map(roster.map(person => [assignmentKey(person.id), String(person.name || person.id)]));
        // newLead: who leads the job once it is approved (the coworker takes over a lead who hands the job on).
        const leadAfter = swap => { const lead = assignmentKey(live.get(swap.jobId)?.crewLead); return !lead ? '' : lead === assignmentKey(swap.from) ? swap.toName : names.get(lead) || lead; };
        const approvals = view(open).filter(swap => SWAP_OPEN.includes(swap.status)).map(swap => ({ ...swap, newLead: leadAfter(swap), canDecide: !([swap.from, swap.to].includes(me) && !isHubOwner(actor)) }));
        return reply(200, { ok: true, asOf, mine: view(mine), incoming: view(incoming), jobs: swappable, coworkers, canApprove: manager, ...(manager ? { approvals } : {}) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw fail('shift_swap_forbidden', 'Ask for swaps from the Hub.', 403);
        const actor = await session(request, env).catch(() => null); requireSwapSession(actor);
        if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw fail('shift_swap_request_invalid', 'Send JSON.', 415);
        const raw = await request.text();
        if (raw.length > 8000) throw fail('shift_swap_request_invalid', 'This request is too large.', 413);
        let input; try { input = JSON.parse(raw); } catch { throw fail('shift_swap_request_invalid', 'Send JSON.'); }
        if (!input || typeof input !== 'object') throw fail('shift_swap_request_invalid', 'Send JSON.');
        const at = now().toISOString(), store = dispatch(env);
        if (input.action === 'request') {
          const swapId = `swap_${String(input.requestId || '').toLowerCase().replace(/-/g, '')}`;
          if (SWAP_ID.test(swapId)) {
            const existing = await store.read('shiftSwaps', swapId);
            if (existing) {
              if (assignmentKey(existing.from) !== assignmentKey(actor.user)) throw fail('shift_swap_request_invalid', 'This request ID was already used.', 409);
              return reply(200, { ok: true, swap: swapView(existing, Date.parse(at)), replayed: true });
            }
          }
          if (!/^[A-Za-z0-9_-]{1,180}$/.test(String(input.jobId || ''))) throw fail('shift_swap_request_invalid', 'Choose the job and the coworker who will take it.');
          const me = assignmentKey(actor.user), lockId = await swapLockId(input.jobId, me);
          const [job, roster, open, lock] = await Promise.all([store.read('jobs', input.jobId), store.roster(), store.shiftSwaps({ field: 'from', op: 'EQUAL', value: me }, [...SWAP_FIELDS]), store.read('shiftSwapLocks', lockId)]);
          const swap = requestSwap({ job, session: actor, input, roster, openSwaps: open, now: at });
          const alreadyOpen = () => fail('shift_swap_already_open', 'You already asked someone to take this job. Cancel that request first.', 409);
          // The lock names the requester's last request for this job; while that one is open, no second one is written.
          if (lock?.swapId && lock.swapId !== swap.id) { const held = await store.read('shiftSwaps', lock.swapId); if (held && SWAP_OPEN.includes(swapView(held, Date.parse(at)).status)) throw alreadyOpen(); }
          try {
            await store.commit([{ collection: 'shiftSwaps', id: swap.id, patch: swap },
              { collection: 'shiftSwapLocks', id: lockId, ...(lock ? { revision: lock.revision } : {}), patch: { jobId: swap.jobId, from: me, swapId: swap.id, updatedAt: at } }]);
          } catch (error) {
            if (error?.code !== 'dispatch_revision_conflict') throw error;
            // Lost the race: the same request saved by a retry is a replay; another request for the job holds the lock.
            const saved = await store.read('shiftSwaps', swap.id);
            if (saved && assignmentKey(saved.from) === me) return reply(200, { ok: true, swap: swapView(saved, Date.parse(at)), replayed: true });
            throw alreadyOpen();
          }
          return reply(200, { ok: true, swap: swapView(swap, Date.parse(at)), replayed: false });
        }
        if (!SWAP_ID.test(String(input.swapId || ''))) throw fail('shift_swap_request_invalid', 'Choose a swap request.');
        const swap = await store.read('shiftSwaps', input.swapId);
        if (!swap) throw fail('shift_swap_not_found', 'This swap request no longer exists.', 404);
        const nowMs = Date.parse(at);
        const save = async (next, base = swap) => { await store.commit([{ collection: 'shiftSwaps', id: swap.id, revision: base.revision, patch: strip(next) }]); return next; };
        const target = { accept: 'accepted', decline: 'declined', cancel: 'cancelled', deny: 'denied', approve: 'approved' }[input.action];
        if (!target) throw fail('shift_swap_request_invalid', 'Choose Accept, Decline, Cancel, Approve or Deny.');
        // A repeated answer (a lost reply) is a replay, not a conflict.
        const last = Array.isArray(swap.history) ? swap.history.at(-1) : null;
        if (swap.status === target && assignmentKey(last?.by) === assignmentKey(actor.user)) return reply(200, { ok: true, swap: swapView(swap, Date.parse(at)), replayed: true });
        if (input.action !== 'approve') {
          let next = answerSwap({ swap, session: actor, env, action: input.action, note: input.note, now: at });
          if (next.status === 'accepted') {
            // The coworker accepts only a swap that still fits the job.
            // The coworker accepts only a swap that still fits the job, at the time it was asked for.
            const job = await store.read('jobs', swap.jobId);
            const blocker = job ? swapRescheduled(swap, job) || swapBlocker(job, nowMs) || (swapDispatchChanges(job, swap) ? '' : 'The crew on this job changed since the request.') : GONE;
            if (blocker) { await save(expireSwap(swap, at, blocker)); throw fail('shift_swap_job_unavailable', `${blocker} The request has expired.`, 409); }
            // What the coworker agreed to: the approval is held to this schedule.
            next = { ...next, jobDate: job.date, jobTime: job.time, jobStartAt: new Date(jobStart(job)).toISOString(), jobSchedule: swapSchedule(job) };
          }
          next = await save(next);
          if (next.status === 'expired') throw fail('shift_swap_expired', 'This job has started, so the request expired.', 409);
          return reply(200, { ok: true, swap: swapView(next, Date.parse(at)), replayed: false });
        }
        requireApprover(swap, actor, env);
        if (!['accepted', 'approving'].includes(swap.status) || swapView(swap, nowMs).status !== swap.status) {
          if (swapView(swap, nowMs).status === 'expired' && SWAP_EXPIRES.includes(swap.status)) await save(expireSwap(swap, at, 'The job started first.'));
          throw fail('shift_swap_state', swap.status === 'requested' ? 'The coworker has not accepted yet.' : 'This swap is closed or the job has started.', 409);
        }
        const requestId = await swapDispatchRequestId(swap.id), receipt = await store.read('dispatchOperations', requestId);
        let current = swap;
        if (!receipt) {
          // Not moved yet: the live job must still be the one the coworker accepted.
          const job = await store.read('jobs', swap.jobId), why = lapsed(swap, job, nowMs);
          if (why) { await save(expireSwap(swap, at, why)); throw fail(why === RESCHEDULED_TEXT ? 'shift_swap_rescheduled' : 'shift_swap_job_unavailable', `${why} The request has expired.`, 409); }
          const blocker = swapBlocker(job, nowMs), changes = blocker ? null : swapDispatchChanges(job, swap);
          const back = () => ({ ...current, status: 'accepted', dispatchRequestId: '', updatedAt: at });
          if (!changes) {
            if (swap.status === 'approving') await save(back());
            throw fail('shift_swap_job_unavailable', blocker || 'The crew on this job changed since the request. Deny it, or change the job in Dispatch.', 409);
          }
          if (swap.status === 'accepted') {
            // Claim the approval first: a cancel, decline or denial racing it now fails its revision check.
            await save({ ...swap, status: 'approving', dispatchRequestId: requestId, updatedAt: at });
            current = await store.read('shiftSwaps', swap.id);
            if (current?.status !== 'approving' || current.dispatchRequestId !== requestId) throw fail('shift_swap_changed', 'This changed while you were looking at it. Refresh and try again.', 409);
          }
          try {
            await mutateDispatch(store, actor, { action: 'schedule.update', requestId, jobId: job.id, expectedRevision: job.revision, changes }, at,
              { travel: travel({ env, store, now, googleLimit: 0, cacheWrites: false }), crewAlternatives: false });
          } catch (error) {
            // A refusal can come after the move saved (another manager's approval of the same swap, or a Dispatch edit
            // between the save and its read-back): then the receipt exists and the approval finishes. Otherwise a refusal
            // never saved, so the swap goes back to accepted; an unknown outcome stays approving for a retry.
            const moved = await store.read('dispatchOperations', requestId).catch(() => null);
            if (!moved) {
              if (error?.status && error.status < 500) await save(back(), current).catch(() => null);
              throw error;
            }
          }
        }
        const history = [...(Array.isArray(current.history) ? current.history : []), { action: 'approved', by: actor.user, at }].slice(-30);
        let next;
        try { next = await save({ ...current, status: 'approved', decidedBy: actor.user, decidedAt: at, dispatchRequestId: requestId, updatedAt: at, history }, current); }
        catch (error) {
          // Another manager's approval of the same swap finished it first: the same result, so a replay.
          const latest = error?.code === 'dispatch_revision_conflict' ? await store.read('shiftSwaps', swap.id) : null;
          if (latest?.status === 'approved' && latest.dispatchRequestId === requestId) return reply(200, { ok: true, swap: swapView(latest, nowMs), replayed: true });
          throw error;
        }
        return reply(200, { ok: true, swap: swapView(next, nowMs), replayed: Boolean(receipt) });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = shiftSwapHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
