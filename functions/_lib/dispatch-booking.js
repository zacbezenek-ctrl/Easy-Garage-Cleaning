import { canDispatch } from './dispatch-permissions.js';
import { DISPATCH_ACTIONS } from './dispatch-contract.js';
import { requiredSkillsOf } from './dispatch-rules.js';
import { mutateDispatch, projectDispatchJob, requireDispatcher } from './dispatch-service.js';
import { assignmentKey } from './job-assignment.js';
import { can, staffRoleAccessEnabled } from './staff-roles.js';

/** AUTH-ROLES (EGC_STAFF_ROLE_ACCESS): schedule.book, the booking right of the sales
 * and phone roles (owner decision 2026-09-29: walkthroughs AND service jobs, like a
 * manager for scheduling). A booker reads the schedule (overview, openings, search,
 * drive times) and books, moves, cancels, restores and marks no-shows for customer
 * visits through mutateDispatch, with its receipts, day locks, owner rules and
 * conflicts. Crew assignment (people, crews, vehicles, split segments, open-shift
 * offers), crews, vehicles, time off and company-wide blocks stay dispatch.write, and
 * so do money (requireMoneyManager) and pay. A crew field is accepted only when it
 * changes nothing: empty on a new visit, the crew Dispatch shows on an existing one (the
 * Hub booking form sends it back with a reschedule). On a job offered for crew pickup the
 * crew size and required skills decide who may assign themselves, so they count as crew
 * fields there. A booker cannot staff a visit, so the owner's crew-size rule stays a
 * warning for them (the job waits in To schedule for a manager), as for a sales handoff.
 * With the flag off can() never grants schedule.book, so every check here is
 * requireDispatcher. */
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const BOOKING_ACTIONS = Object.freeze(['schedule.create', 'schedule.update', 'schedule.cancel', 'schedule.restore', 'schedule.no_show']);
export const CREW_FIELDS = Object.freeze(['assignedCrew', 'crewLead', 'crewId', 'vehicleId', 'assignmentSegments', 'shiftPickupEnabled']);
export const PICKUP_FIELDS = Object.freeze(['crewNeeded', 'requiredSkills']);
export const ROLE_DENIAL = Object.freeze({
  schedule: 'Scheduling needs the Manager, Sales or Phone role. Ask the owner.',
  crew: 'Crew assignment needs the Manager role. Ask the owner. Save the visit without crew changes; a manager staffs it in Dispatch.',
  action: 'Crews, vehicles, time off and company-wide blocks need the Manager role. Ask the owner.',
});

/** {dispatcher, booker} for a schedule read or change. Throws as requireDispatcher does
 * (401 dispatch_sign_in_required, 403 dispatch_forbidden); with the flag on the 403
 * names the roles that can schedule. */
export function requireScheduleAccess(session, env) {
  if (session && !canDispatch(session, env) && can(session, 'schedule.book', env)) return { dispatcher: false, booker: true };
  if (session && staffRoleAccessEnabled(env) && !canDispatch(session, env)) throw fail('dispatch_forbidden', ROLE_DENIAL.schedule, 403);
  requireDispatcher(session, env);
  return { dispatcher: true, booker: false };
}

/** The library check (options.authorize) for a booker's read or change, with the handler's env. */
export const bookerAuthorize = env => session => {
  if (!session) throw fail('dispatch_sign_in_required', 'Sign in to the Employee Hub to use dispatch.', 401);
  if (!can(session, 'schedule.book', env)) throw fail('dispatch_forbidden', ROLE_DENIAL.schedule, 403);
};

// The crew a visit shows in Dispatch (projectDispatchJob: a legacy assignedTo name resolved
// against the roster) or a new visit's none, in the shape each field compares by. A split
// job compares each segment's crew, lead, crew and vehicle; its dates, times and notes are
// a booking.
const crewKeys = value => (Array.isArray(value) ? value : []).map(item => assignmentKey(plain(item) ? item.username || item.user || item.id || item.name : item)).filter(Boolean).sort();
const crewValue = {
  assignedCrew: value => canonical(crewKeys(value)),
  crewLead: value => assignmentKey(value || ''),
  crewId: value => value || null,
  vehicleId: value => value || null,
  assignmentSegments: value => canonical((Array.isArray(value) ? value : []).filter(plain).map(segment => ({ id: segment.id ?? null, crew: crewKeys(segment.assignedCrew), lead: assignmentKey(segment.crewLead || ''), crewId: segment.crewId || null, vehicleId: segment.vehicleId || null }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))),
  shiftPickupEnabled: value => value === true,
};
const pickupValue = { crewNeeded: value => Number(value) || 1, requiredSkills: value => canonical(requiredSkillsOf({ requiredSkills: value }).sort()) };
const touchesCrew = changes => plain(changes) && [...CREW_FIELDS, ...PICKUP_FIELDS].some(key => Object.hasOwn(changes, key));
export function changesCrew(changes, current = null, roster = [], now = new Date().toISOString()) {
  if (!plain(changes)) return false;
  const shown = current ? projectDispatchJob(current, roster, now) : null;
  const differs = (fields, key) => Object.hasOwn(changes, key) && fields[key](changes[key]) !== fields[key](shown ? shown[key] : undefined);
  return CREW_FIELDS.some(key => differs(crewValue, key)) || current?.shiftPickupEnabled === true && PICKUP_FIELDS.some(key => differs(pickupValue, key));
}

/** A booker's change, checked against the booking right and then saved by mutateDispatch
 * exactly as a manager's would be. */
export async function mutateBooking(store, session, input, now = new Date().toISOString(), options = {}, env = {}) {
  const authorize = bookerAuthorize(env);
  authorize(session);
  if (plain(input) && DISPATCH_ACTIONS.includes(input.action)) {
    if (!BOOKING_ACTIONS.includes(input.action) || input.action === 'schedule.create' && input.kind === 'blocked') throw fail('dispatch_forbidden', ROLE_DENIAL.action, 403);
    if (input.action === 'schedule.create') { if (changesCrew(input.changes)) throw fail('dispatch_forbidden', ROLE_DENIAL.crew, 403); }
    else if (typeof input.jobId === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(input.jobId) && !/^(secure_|_egc_)/.test(input.jobId)) {
      const current = await store.read('jobs', input.jobId);
      // A company block, or crew changed against the revision the booker saw. Any other
      // mismatch (missing job, stale revision, replay) is mutateDispatch's to answer.
      if (current && !current.recordType && current.type === 'blocked') throw fail('dispatch_forbidden', ROLE_DENIAL.action, 403);
      if (current && current.revision === input.expectedRevision && touchesCrew(input.changes) && changesCrew(input.changes, current, await store.roster(), now)) throw fail('dispatch_forbidden', ROLE_DENIAL.crew, 403);
    }
  }
  const enforce = warning => warning.code !== 'crew_size_short' && (typeof options.enforce !== 'function' || options.enforce(warning) === true);
  return mutateDispatch(store, session, input, now, { ...options, authorize, enforce });
}
