import { createJobAssignmentAccess, jobCrewNames } from './job-assignment.js';
import { hasBusinessAccess } from './hub-session.js';
import { defaultStaffRoles, sanitizeStaffRoles } from './staff-roles.js';
import { customerPhotosEnabled } from './customer-photo-visibility.js';

// Exactly "true" lets only the job's crew lead or a manager complete a job and send
// its "on my way" message. Unset: every assigned crew member can, exactly as before.
export const fieldLeadOnlyComplete = env => env?.FIELD_LEAD_ONLY_COMPLETE === 'true';

// The P1-08 crew_lead role: stored staff roles when present, else the account's configured role.
const crewLeadRole = session => (sanitizeStaffRoles(session?.staffRoles, session) || defaultStaffRoles(session)).includes('crew_lead');

/**
 * Whether the signed-in employee leads this job. A named job.crewLead must match the session exactly by
 * username (a legacy display-name lead counts only when that name is unique, via the assignment matcher).
 * A job without a named lead is led by its only assigned member, or by an assigned member holding the
 * crew_lead role.
 */
export async function fieldJobLead({ session, job, access }) {
  if (!session?.user || !job) return false;
  if (job.crewLead) return access.matches(job.crewLead);
  if (!await access.assigned(job)) return false;
  return jobCrewNames(job).length === 1 || crewLeadRole(session);
}

/**
 * What the field UI may offer this viewer on this job. `assigned` says the viewer is on the job's crew (the check
 * /api/employee-hub makes before new job time starts on it), so crew/job.js moves only a crew member's own time with the
 * status they set, never a manager's who is not on the crew. The server enforces each one: `complete` in fieldCommand,
 * `sendOnMyWay` in approved-send's on_my_way policy (an owner/manager, or assigned crew, narrowed to the lead
 * by FIELD_LEAD_ONLY_COMPLETE), `sharePhotos` in /api/field-photo-sharing (owner/manager, customer photos on)
 * and `configureChecklist` in the manager-only checklist editor. With the flag off every assigned member (and
 * any manager) keeps today's rights.
 */
export async function fieldCapabilities({ session, manager = false, job, env = {}, access = createJobAssignmentAccess(env, session) } = {}) {
  const lead = await fieldJobLead({ session, job, access }), assigned = await access.assigned(job);
  const leader = manager === true || lead, dispatcher = hasBusinessAccess(session) && ['owner', 'manager'].includes(session?.role);
  const allowed = fieldLeadOnlyComplete(env) ? leader : leader || assigned;
  return { lead, assigned, complete: allowed, sendOnMyWay: dispatcher || assigned && (lead || !fieldLeadOnlyComplete(env)), sharePhotos: dispatcher && customerPhotosEnabled(env), configureChecklist: manager === true };
}
