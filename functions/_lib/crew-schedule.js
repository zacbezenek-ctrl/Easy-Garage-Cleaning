import { can, staffRoleAccessEnabled } from './staff-roles.js';
import { hasBusinessAccess } from './hub-session.js';
import { addDays, denverToday, occupiedDays, validDate } from './dispatch-time.js';
import { jobSegments } from './dispatch-segments.js';
import { crewJobProjection } from './crew-job-projection.js';
import { fieldCancelled, fieldId } from './field-execution.js';
import { assignmentKey } from './job-assignment.js';

/** CREW-SCHEDULE (WP6, owner decision D6 2026-10-17): the crew app's schedule by crew, read only.
 * GET /api/crew-schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=mine|all (Denver dates, at most 14 days; default today
 * through the next 6 days, scope mine).
 *   scope=mine: the crew work in the window the viewer is assigned to, or that is booked for an active crew whose
 *   memberIds (or lead) names the viewer. A crewmate's job on the viewer's crew shows even on a day the viewer is not
 *   on it, and someone who joined a crew after a job was booked still sees it.
 *   scope=all: every crew's work in the window grouped by crew (crew priority, then name), plus the work on no crew.
 *   It needs schedule.view (staff-roles.js: owner, manager and team_lead with EGC_STAFF_ROLE_ACCESS; with that flag
 *   off, business access). Anyone else gets 403 crew_schedule_forbidden.
 * Crew work is type job, cleanout or reorg; walkthroughs, company blocks, time off and private records never show.
 * Each row is a crewJobProjection row narrowed to the schedule: day, time, arrival window, service, the customer's
 * first name, the city, crew and lead. No phone, street address, notes, instructions, conversation, crew roster or
 * money ever leaves here; the job page (/crew/job.html, which checks the assignment itself) stays the only way into a
 * job's details, and canOpen says whether it will open for this viewer.
 * Reads: the crew records (one equality query on dispatchResources.recordType) and the jobs whose start date is in
 * [from - 32 days, to] (one bounded range on `date`, masked to CREW_SCHEDULE_FIELDS), never a whole-collection scan. */
export const CREW_SCHEDULE_MAX_DAYS = 14;
// A job spans at most 31 days (dispatch-time.js scheduleInterval), 32 calendar days across a spring-forward change.
export const CREW_SCHEDULE_LOOKBACK_DAYS = 32;
const CREW_WORK = new Set(['job', 'cleanout', 'reorg']);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_PRIORITY = 99;
/** The stored fields the schedule reads: what crewJobProjection needs for these rows, with no money, phone, notes or
 * instructions. */
export const CREW_SCHEDULE_FIELDS = Object.freeze(['type', 'recordType', 'status', 'pipelineStatus', 'date', 'endDate', 'time', 'endTime', 'allDay',
  'arrivalWindow', 'serviceType', 'customer', 'address', 'assignedCrew', 'assignedTo', 'crewLead', 'crewId', 'crewName', 'crewNeeded', 'requiredCrewSize',
  'crewSize', 'assignmentSegments', 'durationMin', 'estimatedDurationMin', 'fieldExecution.activity', 'startedAt', 'completedAt', 'cancelledAt']);

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const text = (value, max = 150) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Whether this session may read every crew's schedule (scope=all). */
export function canViewAllSchedules(session, env = {}) {
  if (!session?.user) return false;
  return staffRoleAccessEnabled(env) ? can(session, 'schedule.view', env) : hasBusinessAccess(session);
}

/** The Denver window and scope a request names; 400 crew_schedule_range_invalid or crew_schedule_scope_invalid otherwise. */
export function scheduleWindow(params, now = new Date()) {
  const from = params.get('from') || denverToday(now), to = params.get('to') || addDays(from, 6), scope = params.get('scope') || 'mine';
  if (!validDate(from) || !validDate(to) || to < from || to > addDays(from, CREW_SCHEDULE_MAX_DAYS - 1)) throw fail('crew_schedule_range_invalid', `Choose a valid Mountain date range of 1–${CREW_SCHEDULE_MAX_DAYS} days.`, 400);
  if (!['mine', 'all'].includes(scope)) throw fail('crew_schedule_scope_invalid', 'Choose your crews or all crews.', 400);
  return { from, to, scope };
}

/** A customer's first name only, as the schedule shows it. */
export function firstName(value) {
  return text(value, 200).split(/\s+/)[0].replace(/[^\p{L}\p{M}'.-]/gu, '').slice(0, 40);
}

/** The city of a formatted address ("12 Elm St, Fort Collins, CO 80525" -> "Fort Collins"), or '' when unsure. */
export function areaOf(address) {
  const parts = text(address, 1000).split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length && /^(?:usa|us|united states)$/i.test(parts.at(-1))) parts.pop();
  let tail = false;
  while (parts.length > 1 && /^(?:(?:[A-Za-z]{2}\.?|colorado|wyoming)\s*)?(?:\d{5}(?:-\d{4})?)?$/i.test(parts.at(-1))) { parts.pop(); tail = true; }
  if (parts.length < 2) return '';
  const city = tail ? parts.at(-1) : parts.at(-1).replace(/\s+\d{5}(?:-\d{4})?$/, '').replace(/\s+[A-Za-z]{2}\.?$/, '');
  return /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(city) ? city : '';
}

// The days a schedule row occupies inside the window: its Denver interval, else its wall dates (at most 32).
function windowDays(row, from, to) {
  let days = occupiedDays(row);
  if (!days.length && validDate(row.date)) {
    const end = validDate(row.endDate) && row.endDate > row.date ? row.endDate : row.date;
    for (let day = row.date; day && day <= end && days.length < 32; day = addDays(day, 1)) days.push(day);
  }
  return days.filter(day => day >= from && day <= to);
}

const priorityOf = crew => Number.isInteger(crew?.priority) && crew.priority >= 1 && crew.priority <= 99 ? crew.priority : DEFAULT_PRIORITY;
const byCrew = (a, b) => priorityOf(a) - priorityOf(b) || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id));
const byTime = (a, b) => `${a.days[0]} ${a.time || '99:99'}`.localeCompare(`${b.days[0]} ${b.time || '99:99'}`) || a.id.localeCompare(b.id) || String(a.segmentId || '').localeCompare(String(b.segmentId || ''));

/** Every username the schedule may name as a lead (crew records and rows), so the handler resolves only those. */
export function scheduleLeads(crews, jobs) {
  const ids = new Set();
  for (const crew of crews) if (typeof crew?.leadId === 'string') ids.add(assignmentKey(crew.leadId));
  for (const job of jobs) for (const row of jobSegments(job || {})) if (typeof row.crewLead === 'string') ids.add(assignmentKey(row.crewLead));
  ids.delete('');
  return ids;
}

/**
 * The schedule response body. `crews` are dispatchResources crew rows, `jobs` the dated jobs rows, `access` the
 * request's createJobAssignmentAccess and `names` maps a lower-case username to a display name.
 */
export async function crewSchedule({ session, env = {}, crews, jobs, access, names = {}, from, to, scope, now = new Date() }) {
  const all = scope === 'all', manager = hasBusinessAccess(session), name = id => names[assignmentKey(id)] || text(id, 120);
  const crewRows = crews.filter(crew => crew?.recordType === 'crew' && fieldId(crew.id) && typeof crew.name === 'string' && crew.name.trim());
  const member = crew => [...(Array.isArray(crew.memberIds) ? crew.memberIds : []), crew.leadId].some(id => typeof id === 'string' && access.exactly(id));
  const mineCrews = new Set(crewRows.filter(crew => crew.status !== 'inactive' && member(crew)).map(crew => crew.id));
  const known = new Map(crewRows.map(crew => [crew.id, crew]));
  const rows = [];
  for (const job of jobs) {
    if (!job || !CREW_WORK.has(job.type) || job.recordType || !fieldId(job.id) || fieldCancelled(job)) continue;
    for (const row of jobSegments(job)) {
      const days = windowDays(row, from, to);
      if (!days.length) continue;
      const mine = await access.assigned(row), crew = row.crewId ? known.get(row.crewId) || null : null;
      if (!all && !mine && !(crew && mineCrews.has(crew.id))) continue;
      // A segment row is an unsplit job (jobSegments), so the projection reads its own window, crew and lead.
      const view = crewJobProjection(row, { viewer: session.user, crewName: crew?.name || '' });
      rows.push({ crew, row: {
        id: view.id, ...(row.segmentId ? { segmentId: row.segmentId } : {}), type: view.type, status: view.status,
        date: view.date, endDate: view.endDate, time: view.time, endTime: view.endTime, arrivalWindow: view.arrivalWindow, days,
        serviceType: view.serviceType, customer: firstName(view.customer), area: areaOf(view.address),
        crewId: crew ? crew.id : '', crewName: crew ? text(crew.name, 100) : text(view.crewName, 100),
        lead: view.crewLead ? name(view.crewLead) : crew?.leadId ? name(crew.leadId) : '',
        crewSize: view.assignedCrew.length, crewNeeded: Number.isFinite(view.crewNeeded) && view.crewNeeded > 0 ? view.crewNeeded : 1,
        mine, canOpen: mine || manager,
      } });
    }
  }
  const crewView = crew => ({ id: crew.id, name: text(crew.name, 100), ...(text(crew.code, 40) ? { code: text(crew.code, 40) } : {}), lead: crew.leadId ? name(crew.leadId) : '',
    mine: mineCrews.has(crew.id), ...(Array.isArray(crew.serviceDays) ? { serviceDays: DAYS.filter(day => crew.serviceDays.includes(day)) } : {}) });
  const groups = [...known.values()].sort(byCrew).map(crew => ({ crew, jobs: rows.filter(item => item.crew === crew).map(item => item.row).sort(byTime) }))
    .filter(group => group.jobs.length || mineCrews.has(group.crew.id) || all && group.crew.status !== 'inactive')
    .map(group => ({ crew: crewView(group.crew), jobs: group.jobs }));
  return { ok: true, authority: 'employee_hub', scope, from, to, timeZone: 'America/Denver',
    viewer: { user: session.user, canViewAll: canViewAllSchedules(session, env) },
    groups, unassigned: rows.filter(item => !item.crew).map(item => item.row).sort(byTime),
    coverage: { complete: true, asOf: now.toISOString() } };
}
