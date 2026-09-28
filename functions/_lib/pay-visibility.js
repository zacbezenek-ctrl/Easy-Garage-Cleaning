import { can } from './staff-roles.js';

// Who may see other employees' pay in /api/employee-hub. By default only the owner
// (the owner-only pay.manage capability, as /api/staff-directory already applies):
// managers still see everyone's hours and approvals, and everyone sees their own pay.
// Only the owner moves a stored timecard from one employee to another.
// EGC_STAFF_PAY_OWNER_ONLY=false restores the older rule that every business user
// sees every employee's pay and may move timecards. This rule covers /api/employee-hub
// only: /api/timesheets and its payroll CSV still give every business user each
// employee's rate and gross pay, and pay edits to a business user's own profile and
// timecards follow the older rules.
export const PAY_FIELDS = Object.freeze(['payType', 'hourlyRate', 'grossEstimate', 'bonus', 'tips']);

export const staffPayOwnerOnly = env => env?.EGC_STAFF_PAY_OWNER_ONLY !== 'false';
export const seesOthersPay = (session, env) => !staffPayOwnerOnly(env) || can(session, 'pay.manage', env);

const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const withoutPay = value => Object.fromEntries(Object.entries(value).filter(([key]) => !PAY_FIELDS.includes(key)));

// A timecard's audit history repeats pay changes (before/after), so those go too.
export function payHidden(collection, data) {
  if (!record(data)) return data;
  const next = withoutPay(data);
  if (collection === 'timeEntries' && Array.isArray(data.history)) next.history = data.history.map(entry => record(entry) && record(entry.changes) ? { ...entry, changes: withoutPay(entry.changes) } : entry);
  return next;
}

export const payOwner = (collection, data) => collection === 'profiles' ? data?.username : collection === 'timeEntries' ? data?.employee : null;
export const ownPay = (session, collection, data) => same(payOwner(collection, data), session?.user);

// Rows of the GET response: another employee's profile or timecard loses its pay fields.
export function visiblePay(session, env, collection, data) {
  if (seesOthersPay(session, env) || !['profiles', 'timeEntries'].includes(collection) || ownPay(session, collection, data)) return data;
  return payHidden(collection, data);
}

export function payOwnerOnlyError() {
  return Object.assign(new Error('Only the owner can move a timecard to a different employee, because its pay moves with it.'), { status: 403, code: 'EMPLOYEE_HUB_PAY_OWNER_ONLY' });
}

// A save by someone who cannot see another employee's pay cannot set it either: the stored pay stays.
// A stored timecard's pay travels with it, so such a save cannot move the timecard to a different
// person in either direction (403): moving another employee's shift onto yourself would reveal its
// pay, and moving your own shift, with pay you set, onto someone else would set theirs. A save counts
// as the user's own only when both the stored owner and the owner after the save are that user.
export function incomingPay(session, env, collection, incoming, existing) {
  if (seesOthersPay(session, env) || !['profiles', 'timeEntries'].includes(collection)) return incoming;
  const field = collection === 'profiles' ? 'username' : 'employee', stored = payOwner(collection, existing);
  const after = record(incoming) && Object.hasOwn(incoming, field) ? incoming[field] : stored;
  if (collection === 'timeEntries' && existing && !same(after, stored)) throw payOwnerOnlyError();
  if ((!existing || same(stored, session?.user)) && same(after, session?.user)) return incoming;
  return withoutPay(incoming);
}
