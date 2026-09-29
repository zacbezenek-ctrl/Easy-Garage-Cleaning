import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { TIP_ALLOCATION_ACKNOWLEDGEABLE, TIP_ALLOCATION_JOB_FIELDS, computeTipAllocation, validateTipAllocationRange } from '../_lib/tip-allocation.js';
import { customerTipsEnabled, paymentReviewsForJobs } from '../_lib/customer-payments.js';
import { customerTipsCsv, customerTipsCsvFilename } from '../_lib/payroll-export.js';
import { readJobCostingTimecards } from './job-costing.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body) => Response.json(body, { status, headers });
const fail = (message, code, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const PARAMS = new Set(['start', 'end', 'format', 'acknowledge']);

// A payroll read refuses other sites; a missing header is allowed only because the SameSite=Strict cookie is required.
function sameSite(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

// GET ?config=tips alone answers whether customer tips are on (CUSTOMER_TIPS_ENABLED), from the environment only: no
// job or timecard is read. Time approvals shows its tip section, and reads the allocation, only when they are on.
function configProbe(url) {
  const params = new URL(url).searchParams;
  if (!params.has('config')) return false;
  if (params.get('config') !== 'tips' || [...params.keys()].length !== 1) throw fail('Use config=tips on its own.', 'tip_allocation_query_invalid');
  return true;
}

function query(url) {
  const values = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (!PARAMS.has(key) || Object.hasOwn(values, key)) throw fail('Use start, an exclusive end, and optional format or acknowledge once each.', 'tip_allocation_query_invalid');
    values[key] = value;
  }
  if (!['json', 'csv', undefined].includes(values.format)) throw fail('Use format=json or csv.', 'tip_allocation_query_invalid');
  const acknowledged = values.acknowledge === undefined ? [] : values.acknowledge.split(',');
  if (acknowledged.length && (values.format !== 'csv' || acknowledged.some(reason => !TIP_ALLOCATION_ACKNOWLEDGEABLE.includes(reason)))) throw fail(`Use acknowledge only with format=csv, naming ${TIP_ALLOCATION_ACKNOWLEDGEABLE.join(', ')}.`, 'tip_allocation_query_invalid');
  return { start: values.start, end: values.end, csv: values.format === 'csv', acknowledged: new Set(acknowledged) };
}

/** Customer card tips split by crew job time, for the same weeks as the payroll export (GET /api/timesheets). */
// readReviews(env, jobIds) answers each tipped job's payment reviews (a Map), so a tip on a charge Stripe shows refunded
// is held from the split and the CSV; it fails closed, never as "no reviews".
export function tipAllocationHandlers({ session = getHubSession, storage = moneyStorage, readTimecards = readJobCostingTimecards, readReviews = paymentReviewsForJobs, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameSite(request)) return reply(403, { ok: false, code: 'tip_allocation_origin_forbidden', error: 'Open tip payroll from the Employee Hub.' });
      try {
        const actor = await session(request, env);
        if (!actor?.user) throw fail('Sign in to review crew tips.', 'tip_allocation_sign_in_required', 401);
        if (!hasBusinessAccess(actor)) throw fail('Only operations managers can review crew tip payroll.', 'tip_allocation_forbidden', 403);
        if (configProbe(request.url)) return reply(200, { ok: true, authority: 'employee_hub', tips: { enabled: customerTipsEnabled(env) } });
        const input = query(request.url);
        validateTipAllocationRange(input);
        // The money mask plus the job's assigned crew, so crew who never tracked time to the job hold its tips.
        const [jobs, timecards] = await Promise.all([storage(env).jobs([...TIP_ALLOCATION_JOB_FIELDS]), readTimecards(env)]);
        if (!Array.isArray(jobs) || !Array.isArray(timecards)) throw fail('Jobs and timecards could not be read as complete lists.', 'tip_allocation_records_invalid', 503);
        const asOf = now().toISOString(), range = { jobs, timecards, start: input.start, end: input.end, now: asOf };
        // The tipped jobs are known only after a first pass; their payment reviews are then read, and the pure split runs again.
        const tippedIds = computeTipAllocation(range).jobs.map(job => job.jobId);
        const refundReviews = tippedIds.length ? await readReviews(env, tippedIds) : new Map();
        if (!(refundReviews instanceof Map)) throw fail('Refunds on tipped card payments could not be checked.', 'tip_allocation_records_invalid', 503);
        const allocation = computeTipAllocation({ ...range, refundReviews });
        if (!input.csv) return reply(200, { ok: true, authority: 'employee_hub', ...allocation });
        // Like payroll, tips export only when every share is final, or its one acknowledgeable gap was named.
        const blocking = allocation.coverage.reasons.filter(reason => !input.acknowledged.has(reason));
        if (blocking.length) {
          const why = [...(blocking.includes('untracked_job_time') ? ['Some tips are on jobs where crew time was not tracked to the job, so the Hub cannot split them.'] : []), ...(blocking.includes('no_job_time') ? ['Some tips are on jobs with no recorded crew work time.'] : []),
            ...(blocking.includes('tip_refunded') ? ['Some tips are on card charges the owner recorded as refunded, and their jobs still list the tip: pay one by hand only if it is still owed.'] : [])].join(' ');
          const message = blocking.every(reason => TIP_ALLOCATION_ACKNOWLEDGEABLE.includes(reason)) ? `${why} Export again with acknowledge=${blocking.join(',')} to list those tips as unassigned and pay them by hand.`
            : blocking.includes('tip_refund_open') ? 'Stripe shows a refund on a tipped card charge the owner has not settled yet. Settle it in Hub > Review queues (and correct the job\'s tip) before exporting tips for payroll.'
              : 'Finish, approve or fix every timecard on the tipped jobs (and review any unreadable tip) before exporting tips for payroll.';
          throw fail(message, 'tip_allocation_incomplete', 409, { reasons: allocation.coverage.reasons, blocking, acknowledgeable: blocking.filter(reason => TIP_ALLOCATION_ACKNOWLEDGEABLE.includes(reason)), jobs: allocation.jobs.filter(job => job.reasons.length).map(job => ({ jobId: job.jobId, reasons: job.reasons })) });
        }
        return new Response(customerTipsCsv(allocation), { status: 200, headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${customerTipsCsvFilename(allocation)}"` } });
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('tip_allocation_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
        return reply(503, { ok: false, code: 'tip_allocation_unavailable', error: 'Crew tips could not be read safely. Retry, or contact the Hub administrator.' });
      }
    },
  };
}
const handlers = tipAllocationHandlers();
export const onRequestGet = handlers.get;
