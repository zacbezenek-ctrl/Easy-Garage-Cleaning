/**
 * /api/garage-guard-members — Garage Guard members for owners and managers
 * (requireDispatcher). FUN-20.
 *
 * GET ?period=mtd|today|yesterday|wtd|last_week|last_month|qtd|last_quarter|ytd
 *     |custom&from=YYYY-MM-DD&to=YYYY-MM-DD (exclusive): every membership with its
 *     link, visits, churn class and manual-edit flag (a browser garageGuard
 *     edit that no longer matches the membership), the member visit jobs and
 *     their counting state, and the A8 summary (members, voluntary and
 *     involuntary churn, renewals, visit utilization; revenue, deferred revenue
 *     and MRR for the owner only). Partial data is reported in coverage,
 *     including completed member visits not yet counted or settled and manual
 *     edits open (stored, or seen live on the account job).
 * POST {action, requestId, ...} (same origin, JSON):
 *   visit.apply     {jobId}                               count a completed member visit (needs GARAGE_GUARD_VISIT_TRACKING_ENABLED)
 *   visit.link      {jobId, membershipId, expectedRevision} make a service visit of the member's customer a member visit
 *                   (not one before the membership started or, for a member recorded before FUN-20, before its year on file)
 *   visits.reconcile {membershipId, expectedRevision, visitsRemaining, note, jobIds?, confirmEmptyPeriodIds?} set the true visit count, resolve a manual edit and mirror it;
 *                   jobIds (up to 20 completed member visits the count already includes) are marked reconciled so they are never applied on top of it;
 *                   confirmEmptyPeriodIds (closed years whose member visits could not be listed) records that none of their visits is waiting, audited with the note
 * Nothing here charges, refunds or messages a customer.
 */
import { getHubSession } from '../_lib/hub-session.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { garageGuardAction, garageGuardOverview, garageGuardStorage, garageGuardVisitTrackingEnabled } from '../_lib/garage-guard-visits.js';

const MAX_BODY = 8192, QUERY_KEYS = new Set(['period', 'from', 'to']);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, error, status) => Object.assign(new Error(error), { code, status });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

// Funnel event errors carry the library's generic 503; here they are about this visit's record, never worth retrying unchanged.
const FUNNEL_EVENT_STATUS = { funnel_event_idempotency_conflict: 409, funnel_event_invalid: 400, funnel_event_private_record: 400 };

function errorResponse(error) {
  const code = String(error?.code || '');
  if (Object.hasOwn(FUNNEL_EVENT_STATUS, code)) return reply(FUNNEL_EVENT_STATUS[code], { ok: false, code, error: error.message });
  if (/^(garage_guard_|dispatch_|funnel_period_|funnel_calendar_)/.test(code)) return reply(error.status || 503, { ok: false, code, error: error.message });
  return reply(503, { ok: false, code: 'garage_guard_unavailable', error: 'Garage Guard members could not be loaded or saved. Keep the request and retry it; do not create another.' });
}

export function garageGuardMemberHandlers({ session = getHubSession, storage = garageGuardStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        requireDispatcher(actor);
        const params = new URL(request.url).searchParams, query = {};
        for (const [key, value] of params) {
          if (!QUERY_KEYS.has(key) || Object.hasOwn(query, key)) throw fail('garage_guard_invalid_query', 'Use period, and from/to for a custom period, once each.', 400);
          query[key] = value;
        }
        return reply(200, await garageGuardOverview(storage(env), actor, query, now(), { visitsEnabled: garageGuardVisitTrackingEnabled(env) }));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw fail('garage_guard_origin_forbidden', 'Garage Guard changes must come from the Employee Hub.', 403);
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('garage_guard_content_type', 'Garage Guard changes must be JSON.', 415);
        if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw fail('garage_guard_too_large', 'This request is too large.', 413);
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > MAX_BODY) throw fail('garage_guard_too_large', 'This request is too large.', 413);
        let body;
        try { body = JSON.parse(raw); } catch { throw fail('garage_guard_json_invalid', 'The request could not be read.', 400); }
        const actor = await session(request, env);
        return reply(200, await garageGuardAction(storage(env), actor, body, now().toISOString(), { visitsEnabled: garageGuardVisitTrackingEnabled(env) }));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = garageGuardMemberHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
