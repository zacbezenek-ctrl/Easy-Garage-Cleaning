import { can } from './staff-roles.js';

// Pay and job labor dollars are owner-only by default (EGC_STAFF_PAY_OWNER_ONLY, on unless exactly "false"): only the
// owner (the owner-only pay.manage capability, as /api/staff-directory already applies) sees other employees' pay and
// sets anyone's pay; everyone sees their own; managers keep hours, approvals, flags and paid time-off hours. The flag
// covers:
// - /api/employee-hub reads and saves (and the record a save answers with) of profiles, timecards and time-off
//   requests. Every refusal there is 403 pay_owner_only.
// - /api/timesheets, which hides other employees' rates and gross pay (pay totals null, never 0), and its payroll CSV,
//   which only the owner downloads (403 pay_owner_only).
// - Job labor dollars (seesLaborCost, JOB-COST-PRIVACY): /api/job-costing, /api/money, /api/job-labor-costs, the raw
//   jobs /api/crew-jobs and /api/case-study send back, and the Hub finance board. On a job one employee worked alone,
//   labor cost over hours is that employee's rate, so everyone else gets the hours only, and the figures live in the
//   server-only jobLaborCosts record instead of on the job (functions/_lib/job-labor-private.js). Those modules refuse
//   with their own codes.
// EGC_STAFF_PAY_OWNER_ONLY=false restores the older rules: every business user sees and edits pay, and every
// operations manager (owner or manager role; in /api/job-costing, every business user) sees and enters job labor
// dollars, which saves also write back onto the job as before while still keeping the jobLaborCosts record.
// A write to another employee's record never compares the pay it carries with the stored pay: its outcome
// cannot depend on pay the caller may not see, or a caller could confirm guesses one request at a time.
export const PAY_FIELDS = Object.freeze(['payType', 'hourlyRate', 'grossEstimate', 'bonus', 'tips']);
// Pay fields on stored Employee Hub records (profiles, timecards, time-off requests), with the rate-like keys no reader
// pays from today (overtimeMultiplier, payRates, rate, paidRate), so none of them is stored by a caller without
// pay.manage either. A timecard's grossEstimate is derived from its hours and hourlyRate, so it is recomputed, never set.
export const PAY_WRITE_FIELDS = Object.freeze(['payType', 'hourlyRate', 'regularRate', 'overtimeRate', 'ptoRate', 'payRate', 'bonus', 'tips', 'overtimeMultiplier', 'payRates', 'rate', 'paidRate']);
// A read hides both lists: a rate-like key stored on another employee's record (by the owner, or by a manager while
// every business user could write pay) is not handed back to a viewer who may not see that employee's pay.
const READ_HIDDEN = Object.freeze([...new Set([...PAY_FIELDS, ...PAY_WRITE_FIELDS])]);

export const staffPayOwnerOnly = env => env?.EGC_STAFF_PAY_OWNER_ONLY !== 'false';
export const seesOthersPay = (session, env) => !staffPayOwnerOnly(env) || can(session, 'pay.manage', env);
// Job labor dollars follow the same rule as other employees' pay.
export const seesLaborCost = (session, env) => seesOthersPay(session, env);

const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const withoutPay = value => Object.fromEntries(Object.entries(value).filter(([key]) => !READ_HIDDEN.includes(key)));

// The field naming the employee whose pay an Employee Hub record carries.
const PAY_OWNER_FIELD = Object.freeze({ profiles: 'username', timeEntries: 'employee', requests: 'employee' });
export const payOwnerField = collection => Object.hasOwn(PAY_OWNER_FIELD, collection) ? PAY_OWNER_FIELD[collection] : null;

// A timecard's audit history repeats pay changes (before/after) and the rate a correction sent (request), so those go too.
export function payHidden(collection, data) {
  if (!record(data)) return data;
  const next = withoutPay(data);
  if (collection === 'timeEntries' && Array.isArray(data.history)) next.history = data.history.map(entry => record(entry) && (record(entry.changes) || record(entry.request)) ? { ...entry, ...(record(entry.changes) ? { changes: withoutPay(entry.changes) } : {}), ...(record(entry.request) ? { request: withoutPay(entry.request) } : {}) } : entry);
  return next;
}

export const payOwner = (collection, data) => { const field = payOwnerField(collection); return field ? data?.[field] : null; };
export const ownPay = (session, collection, data) => same(payOwner(collection, data), session?.user);

// A record /api/employee-hub reads, or answers a save with: another employee's profile, timecard or time-off request
// loses its pay fields. The owner, the record's own employee and everyone while the flag is off get it unchanged.
export function visiblePay(session, env, collection, data) {
  if (seesOthersPay(session, env) || !payOwnerField(collection) || ownPay(session, collection, data)) return data;
  return payHidden(collection, data);
}

// The PAY-TIMESHEETS names: payOwnerOnly is staffPayOwnerOnly, and canSeePay asks about one employee.
export const payOwnerOnly = staffPayOwnerOnly;
export const canSeePay = (session, env, subjectId) => seesOthersPay(session, env) || Boolean(String(subjectId || '').trim()) && same(subjectId, session?.user);
export const canSetPay = (session, env) => seesOthersPay(session, env);
// A refused pay change, timecard move or payroll export (403 pay_owner_only).
export const payChangeRefused = (message = 'Only the owner can change pay. Managers keep hours, approvals and paid time-off hours.') => Object.assign(new Error(message), { code: 'pay_owner_only', status: 403 });

// Pay in a computeTimesheetWeek result: per employee row, per timecard and in the totals.
const ROW_PAY = ['regularRate', 'straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay'];
const CARD_PAY = ['hourlyRate', 'bonus', 'tips'];
const TOTAL_PAY = ['straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay'];
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** The week as this viewer may see it. The owner, and everyone while the flag is off, get the same object back
 * (so those responses stay byte-identical). Anyone else loses the pay of every other employee: the row keeps its
 * hours, approvals and flags and says payHidden, and pay totals become null, not 0, when any row is hidden. */
export function timesheetPayView(session, env, week) {
  if (seesOthersPay(session, env)) return week;
  let hidden = false;
  const employees = week.employees.map(row => {
    if (canSeePay(session, env, row.employee)) return row;
    hidden = true;
    return { ...without(row, ROW_PAY), timecards: (row.timecards || []).map(card => without(card, CARD_PAY)), payHidden: true };
  });
  const totals = hidden ? { ...week.totals, ...Object.fromEntries(TOTAL_PAY.map(key => [key, null])), payHidden: true } : week.totals;
  return { ...week, employees, totals, ...(hidden ? { payHidden: true } : {}), payVisibility: 'own' };
}

export const payWriteFields = incoming => record(incoming) ? PAY_WRITE_FIELDS.filter(key => Object.hasOwn(incoming, key)) : [];
export const withoutPayWrites = incoming => record(incoming) ? without(incoming, PAY_WRITE_FIELDS) : incoming;
const amount = value => value === undefined || value === null || value === '' ? 0 : typeof value === 'number' ? value
  : typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
const payTypeOf = value => value === undefined || value === null || value === '' ? 'hourly' : value;
// Values payroll treats alike are the same pay: 25 and '25', a missing bonus and 0, a missing payType and 'hourly'.
export const samePay = (key, left, right) => left === right || (key === 'payType' ? payTypeOf(left) === payTypeOf(right) : amount(left) === amount(right));

/** The pay fields `incoming` would change: those that differ from every baseline (what is stored, and what the
 * server itself would store). A null baseline counts as a record without pay. */
export function changedPay(incoming, ...baselines) {
  if (!record(incoming)) return [];
  const bases = baselines.length ? baselines : [null];
  return PAY_WRITE_FIELDS.filter(key => Object.hasOwn(incoming, key) && bases.every(base => !samePay(key, incoming[key], record(base) ? base[key] : undefined)));
}

// With the flag on, a write by anyone without pay.manage that would change pay is refused (403 pay_owner_only).
// Only for the caller's own records: the baselines are pay the caller may see.
export function assertPayUnchanged(session, env, incoming, ...baselines) {
  if (!canSetPay(session, env) && changedPay(incoming, ...baselines).length) throw payChangeRefused();
}

/** A write to a record that is not the caller's own (the stored owner or the owner after the save is someone else), by
 * a caller without pay.manage (flag on): any pay field is refused whatever its value, and a stored timecard or time-off
 * request never moves to another employee (its pay, and a request's approved paid hours, would move with it, in either
 * direction). Both refusals are 403 pay_owner_only and are decided without reading the stored pay, so a right guess and
 * a wrong guess get the same answer. */
export function assertNoOthersPay(session, env, collection, incoming, { moved = false } = {}) {
  if (canSetPay(session, env)) return;
  if (collection === 'timeEntries' && moved) throw payChangeRefused('Only the owner can move a timecard to another employee, because its pay moves with it.');
  if (collection === 'requests' && moved) throw payChangeRefused('Only the owner can move a time-off request to another employee, because its paid time off moves with it.');
  if (payWriteFields(incoming).length) throw payChangeRefused();
}
