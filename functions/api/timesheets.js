import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { employeeVaultSecret } from '../_lib/employee-vault-key.js';
import { PAY_REVIEW_REASONS, computeTimesheetWeek, overtimePolicy, ptoFromRequests, timesheetWeekStart } from '../_lib/timesheet-week.js';
import { GUSTO_NOT_INCLUDED_HEADER, gustoHoursFile, gustoHoursFilename, payrollCsv, payrollCsvFilename } from '../_lib/payroll-export.js';
import { payChangeRefused, seesOthersPay, timesheetPayView } from '../_lib/pay-visibility.js';
import { can, staffRoleAccessEnabled } from '../_lib/staff-roles.js';
import { gustoPayrollProfiles, staffDirectoryEnabled } from '../_lib/staff-directory.js';
import { readEmployeeHubRecords } from './employee-hub.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body) => Response.json(body, { status, headers });
const fail = (message, code, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const PARAMS = new Set(['view', 'start', 'format', 'includePending', 'acknowledge']);
// Payroll review is time.approve. With EGC_STAFF_ROLE_ACCESS on, can() decides it from the owner-set
// roles (a stored manager reviews; sales and phone do not); off, business access as before.
const reviewsTimesheets = (actor, env) => staffRoleAccessEnabled(env) ? can(actor, 'time.approve', env) : hasBusinessAccess(actor);

// Swappable reader: one vault pass for timecards plus time-off requests (paid PTO).
export async function readTimesheetRecords(env) {
  if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) throw fail('Employee Hub storage is not configured.', 'timesheet_storage_unconfigured', 503);
  const { timeEntries, requests } = await readEmployeeHubRecords(env, ['timeEntries', 'requests']);
  return { timecards: timeEntries, requests };
}

// The Gusto employee IDs, not-paid-through-Gusto marks and display names the owner saved in the staff directory, from the
// sealed profiles (GUSTO-EXPORT).
export async function readGustoPayrollProfiles(env) {
  if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) throw fail('Employee Hub storage is not configured.', 'timesheet_storage_unconfigured', 503);
  const { profiles } = await readEmployeeHubRecords(env, ['profiles']);
  if (!Array.isArray(profiles)) throw fail('Staff profiles could not be read as a complete list.', 'timesheet_records_invalid', 503);
  return gustoPayrollProfiles(profiles);
}

function query(url) {
  const params = new URL(url).searchParams, values = {};
  for (const [key, value] of params) {
    if (!PARAMS.has(key) || Object.hasOwn(values, key)) throw fail('Use view=week, a start date, and optional format, includePending or acknowledge once each.', 'timesheet_query_invalid');
    values[key] = value;
  }
  if (values.view !== 'week') throw fail('Choose the weekly timesheet view.', 'timesheet_query_invalid');
  if (!['json', 'csv', 'gusto', undefined].includes(values.format) || !['0', '1', undefined].includes(values.includePending)) throw fail('Use format=json, csv or gusto and includePending=0 or 1.', 'timesheet_query_invalid');
  // The Gusto hours file is approved time only: pending timecards are never included in it.
  if (values.format === 'gusto' && values.includePending === '1') throw fail('The Gusto hours file has approved time only. Approve or reject the pending timecards first.', 'timesheet_query_invalid');
  // A manager may export with pay-review flags only by naming each one (acknowledge=missing_rate,non_hourly_pay_type).
  const acknowledged = values.acknowledge === undefined ? [] : values.acknowledge.split(',');
  if (acknowledged.length && (!['csv', 'gusto'].includes(values.format) || acknowledged.some(reason => !PAY_REVIEW_REASONS.includes(reason)))) throw fail(`Use acknowledge only with format=csv or gusto, naming ${PAY_REVIEW_REASONS.join(', ')}.`, 'timesheet_query_invalid');
  return { weekStart: timesheetWeekStart(values.start), csv: ['csv', 'gusto'].includes(values.format), gusto: values.format === 'gusto', includePending: values.includePending === '1', acknowledged: new Set(acknowledged) };
}

export function timesheetHandlers({ session = getHubSession, read = readTimesheetRecords, gustoProfiles = readGustoPayrollProfiles, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if (!actor?.user) throw fail('Sign in to review timesheets.', 'timesheet_sign_in_required', 401);
        if (!reviewsTimesheets(actor, env)) throw fail(staffRoleAccessEnabled(env) ? 'Timesheets need the Manager role. Ask the owner.' : 'Only operations managers can review payroll timesheets.', 'timesheet_forbidden', 403);
        const input = query(request.url);
        // EGC_STAFF_PAY_OWNER_ONLY (default on): the payroll CSV is the owner's (pay.manage), and every other viewer's
        // JSON loses the other employees' pay (timesheetPayView). Off, every business user gets both as before.
        if (input.csv && !input.gusto && !seesOthersPay(actor, env)) throw payChangeRefused('Only the owner can download the payroll export. Managers review hours and approvals here.');
        // The Gusto hours file (GUSTO-EXPORT) is the owner's whatever EGC_STAFF_PAY_OWNER_ONLY says: it runs payroll.
        if (input.gusto && !can(actor, 'pay.manage', env)) throw payChangeRefused('Only the owner can download the Gusto hours file. Managers review hours and approvals here.');
        const policy = overtimePolicy(env), records = await read(env);
        if (!Array.isArray(records?.timecards) || !Array.isArray(records?.requests)) throw fail('Timecards could not be read as a complete list.', 'timesheet_records_invalid', 503);
        const week = computeTimesheetWeek({ timecards: records.timecards, pto: ptoFromRequests(records.requests), policy, weekStart: input.weekStart, includePending: input.includePending, now: now().toISOString() });
        if (!input.csv) return reply(200, { ok: true, ...timesheetPayView(actor, env, week) });
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
        if (input.gusto) {
          let file;
          try { file = gustoHoursFile(week, await gustoProfiles(env)); }
          catch (error) {
            if (error?.code === 'timesheet_gusto_id_missing' && !staffDirectoryEnabled(env)) error.message += ' The staff directory is off: the owner turns it on with EGC_STAFF_DIRECTORY_ENABLED=true.';
            throw error;
          }
          // Who was left out as not paid through Gusto, for the Hub's notice after the download.
          const left = file.notInGusto.length ? { [GUSTO_NOT_INCLUDED_HEADER]: encodeURIComponent(JSON.stringify(file.notInGusto)) } : {};
          return new Response(file.csv, { status: 200, headers: { ...headers, ...left, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${gustoHoursFilename(week)}"` } });
        }
        return new Response(payrollCsv(week), { status: 200, headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${payrollCsvFilename(week)}"` } });
      } catch (error) {
        if (typeof error?.code === 'string' && (error.code.startsWith('timesheet_') || error.code === 'pay_owner_only')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
        return reply(503, { ok: false, code: 'timesheet_unavailable', error: 'Timesheets could not be read safely. Retry, or contact the Hub administrator.' });
      }
    },
  };
}
const handlers = timesheetHandlers();
export const onRequestGet = handlers.get;
