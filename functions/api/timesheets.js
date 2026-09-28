import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { employeeVaultSecret } from '../_lib/employee-vault-key.js';
import { PAY_REVIEW_REASONS, computeTimesheetWeek, overtimePolicy, ptoFromRequests, timesheetWeekStart } from '../_lib/timesheet-week.js';
import { payrollCsv, payrollCsvFilename } from '../_lib/payroll-export.js';
import { readEmployeeHubRecords } from './employee-hub.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body) => Response.json(body, { status, headers });
const fail = (message, code, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const PARAMS = new Set(['view', 'start', 'format', 'includePending', 'acknowledge']);

// Swappable reader: one vault pass for timecards plus time-off requests (paid PTO).
export async function readTimesheetRecords(env) {
  if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) throw fail('Employee Hub storage is not configured.', 'timesheet_storage_unconfigured', 503);
  const { timeEntries, requests } = await readEmployeeHubRecords(env, ['timeEntries', 'requests']);
  return { timecards: timeEntries, requests };
}

function query(url) {
  const params = new URL(url).searchParams, values = {};
  for (const [key, value] of params) {
    if (!PARAMS.has(key) || Object.hasOwn(values, key)) throw fail('Use view=week, a start date, and optional format, includePending or acknowledge once each.', 'timesheet_query_invalid');
    values[key] = value;
  }
  if (values.view !== 'week') throw fail('Choose the weekly timesheet view.', 'timesheet_query_invalid');
  if (!['json', 'csv', undefined].includes(values.format) || !['0', '1', undefined].includes(values.includePending)) throw fail('Use format=json or csv and includePending=0 or 1.', 'timesheet_query_invalid');
  // A manager may export with pay-review flags only by naming each one (acknowledge=missing_rate,non_hourly_pay_type).
  const acknowledged = values.acknowledge === undefined ? [] : values.acknowledge.split(',');
  if (acknowledged.length && (values.format !== 'csv' || acknowledged.some(reason => !PAY_REVIEW_REASONS.includes(reason)))) throw fail(`Use acknowledge only with format=csv, naming ${PAY_REVIEW_REASONS.join(', ')}.`, 'timesheet_query_invalid');
  return { weekStart: timesheetWeekStart(values.start), csv: values.format === 'csv', includePending: values.includePending === '1', acknowledged: new Set(acknowledged) };
}

export function timesheetHandlers({ session = getHubSession, read = readTimesheetRecords, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if (!actor?.user) throw fail('Sign in to review timesheets.', 'timesheet_sign_in_required', 401);
        if (!hasBusinessAccess(actor)) throw fail('Only operations managers can review payroll timesheets.', 'timesheet_forbidden', 403);
        const input = query(request.url), policy = overtimePolicy(env), records = await read(env);
        if (!Array.isArray(records?.timecards) || !Array.isArray(records?.requests)) throw fail('Timecards could not be read as a complete list.', 'timesheet_records_invalid', 503);
        const week = computeTimesheetWeek({ timecards: records.timecards, pto: ptoFromRequests(records.requests), policy, weekStart: input.weekStart, includePending: input.includePending, now: now().toISOString() });
        if (!input.csv) return reply(200, { ok: true, ...week });
        // Payroll exports only a finished week whose every shift is approved, rejected, or explicitly included, and
        // whose pay-review flags were fixed or explicitly acknowledged.
        const blocking = week.coverage.reasons.filter(reason => !input.acknowledged.has(reason));
        if (blocking.length) {
          const ids = week.unattributed.slice(0, 5).map(item => item.id || '(no id)').join(', ');
          const message = blocking.includes('unattributed_records') ? `These timesheet records have no readable date and could belong to this week: ${ids}. A manager must reject or correct each one before exporting payroll.`
            : blocking.every(reason => PAY_REVIEW_REASONS.includes(reason)) ? `Fix the flagged pay (${blocking.join(', ')}), or export again with acknowledge=${blocking.join(',')} to send them to payroll flagged.`
            : 'Finish the week and approve, reject, or fix every timecard before exporting payroll.';
          throw fail(message, 'timesheet_incomplete', 409, { reasons: week.coverage.reasons, blocking, acknowledgeable: blocking.filter(reason => PAY_REVIEW_REASONS.includes(reason)), needsReview: week.needsReview, unattributed: week.unattributed, excluded: week.excluded });
        }
        return new Response(payrollCsv(week), { status: 200, headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${payrollCsvFilename(week)}"` } });
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('timesheet_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
        return reply(503, { ok: false, code: 'timesheet_unavailable', error: 'Timesheets could not be read safely. Retry, or contact the Hub administrator.' });
      }
    },
  };
}
const handlers = timesheetHandlers();
export const onRequestGet = handlers.get;
