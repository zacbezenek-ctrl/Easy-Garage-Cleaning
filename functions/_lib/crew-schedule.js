import { can } from './staff-roles.js';
import { hasBusinessAccess } from './hub-session.js';
import { addDays, denverToday, occupiedDays, validDate } from './dispatch-time.js';
import { jobSegments } from './dispatch-segments.js';
import { crewJobProjection } from './crew-job-projection.js';
import { fieldActivity, fieldCancelled, fieldId } from './field-execution.js';
import { assignmentKey, ownWalkthroughRight } from './job-assignment.js';
import { SELF_RUN_CARD_FIELDS, selfRunCardHidden } from './knock-self-walkthrough.js';

/** CREW-SCHEDULE (WP6, owner decision D6 2026-10-17): the crew app's schedule by crew, read only.
 * GET /api/crew-schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=mine|all (Denver dates, at most 14 days, starting no more
 * than 14 days ago; default today through the next 6 days, scope mine).
 *   scope=mine: the crew work in the window the viewer is assigned to, or that is booked for an active crew whose
 *   memberIds (or lead) names the viewer. A crewmate's job on the viewer's crew shows even on a day the viewer is not
 *   on it, and someone who joined a crew after a job was booked still sees it.
 *   scope=all: every crew's work in the window grouped by crew (crew priority, then name), plus the work on no crew.
 *   It needs schedule.view (staff-roles.js: business access, or the owner, manager or team_lead role; no flag, the
 *   stored role is the switch). Sales, Phone, crew leads and crew get 403 crew_schedule_forbidden.
 * Crew work is type job, cleanout or reorg; company blocks, time off and private records never show. A walkthrough shows
 * only to the people assigned to it (an estimator's own visits, D2D-BOARD 2026-10-17), in either scope, as a row of type
 * 'walkthrough' on no crew; nobody else's walkthrough ever shows.
 * Each row is a crewJobProjection row narrowed to the schedule: day, time, arrival window, service, the customer's
 * first name, the city, crew and lead, plus today's live state (fieldStatus, CREW_SCHEDULE_LIVE). No phone, street address, notes, instructions, conversation, crew roster or
 * money ever leaves here; the job page (/crew/job.html, which checks the assignment itself) stays the only way into a
 * job's details, and canOpen says whether it will open for this viewer: business access, or an assignment anywhere on
 * the job (its assignedCrew, the union of its segments, exactly as /api/field-jobs checks), while `mine` is the row's
 * own segment.
 * Reads: the crew records (one equality query on dispatchResources.recordType) and, masked to CREW_SCHEDULE_FIELDS,
 * the jobs starting in [from, to] (one bounded range on `date`) plus the multi-day ones that started earlier and end on
 * or after `from` (READ-BUDGET: ranges on endDate and date, the composite index jobs(endDate, date)); until that index
 * is deployed, the jobs whose start date is in [from - 32 days, to] instead, as before. Never a whole-collection scan.
 * Lead display names are resolved only for the leads this answer shows, and only when there is one: configured users
 * for free, any other lead's own employee account with one read (functions/api/crew-schedule.js leadNames).
 * EGC_CREW_SCHEDULE exactly "false" turns the schedule off: 404 crew_schedule_disabled before any read. */
export const CREW_SCHEDULE_MAX_DAYS = 14;
// How far back a window may start: the crew app shows today onward; two weeks of history and no more.
export const CREW_SCHEDULE_HISTORY_DAYS = 14;
export const crewScheduleEnabled = env => env?.EGC_CREW_SCHEDULE !== 'false';
// A job spans at most 31 days (dispatch-time.js scheduleInterval), 32 calendar days across a spring-forward change.
export const CREW_SCHEDULE_LOOKBACK_DAYS = 32;
const CREW_WORK = new Set(['job', 'cleanout', 'reorg']);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_PRIORITY = 99;
/** The stored fields the schedule reads: what crewJobProjection needs for these rows, with no money, phone, notes or
 * instructions. */
export const CREW_SCHEDULE_FIELDS = Object.freeze(['type', 'recordType', 'status', 'pipelineStatus', 'date', 'endDate', 'time', 'endTime', 'allDay',
  'arrivalWindow', 'serviceType', 'customer', 'address', 'assignedCrew', 'assignedTo', 'crewLead', 'crewId', 'crewName', 'crewNeeded', 'requiredCrewSize',
  'crewSize', 'assignmentSegments', 'durationMin', 'estimatedDurationMin', 'fieldExecution.activity', 'fieldExecution.activityAt', 'fieldExecution.visits', 'startedAt', 'completedAt', 'cancelledAt',
  // REP-WALKTHROUGH: whether a walkthrough is a Knock rep's own self-run visit past its right (selfRunCardHidden).
  ...SELF_RUN_CARD_FIELDS.filter(field => !['type', 'recordType', 'status', 'pipelineStatus', 'date', 'assignedCrew'].includes(field))]);
/** The live states a schedule row names (fieldStatus): en route, on site, and the crew's own paused, waiting, delayed
 * and day-ended marks. The stage is the whole job's, so a state shows only on today's row and only when the crew set it
 * today (fieldExecution.activityAt, written with every crew status change): a multi-day job marked on site yesterday
 * shows nothing on today's row until the crew marks it again. Day ended shows only when today's own visit ended: an end of
 * day saved offline for yesterday and synced after midnight (endedLate, field-execution-visits.js) stamps day_ended with
 * the sync time, but today's work has not started. Never the reason, or the visit notes, the crew typed. */
export const CREW_SCHEDULE_LIVE = Object.freeze(['dispatched', 'arrived', 'paused', 'waiting', 'delayed', 'day_ended']);
function liveStatus(job, days, today) {
  const status = fieldActivity(job), at = Date.parse(job.fieldExecution?.activityAt || ''), visit = job.fieldExecution?.visits?.[today];
  if (status === 'day_ended' && !(visit?.status === 'ended' && visit.endedLate !== true)) return '';
  return CREW_SCHEDULE_LIVE.includes(status) && days.includes(today) && Number.isFinite(at) && denverToday(new Date(at)) === today ? status : '';
}

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const text = (value, max = 150) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Whether this session may read every crew's schedule (scope=all): schedule.view, which needs no flag. */
export function canViewAllSchedules(session, env = {}) {
  return Boolean(session?.user) && can(session, 'schedule.view', env);
}

/** The Denver window and scope a request names; 400 crew_schedule_range_invalid or crew_schedule_scope_invalid otherwise. */
export function scheduleWindow(params, now = new Date()) {
  const today = denverToday(now), from = params.get('from') || today, to = params.get('to') || addDays(from, 6), scope = params.get('scope') || 'mine';
  if (!validDate(from) || !validDate(to) || to < from || to > addDays(from, CREW_SCHEDULE_MAX_DAYS - 1) || from < addDays(today, -CREW_SCHEDULE_HISTORY_DAYS)) throw fail('crew_schedule_range_invalid', `Choose a valid Mountain date range of 1–${CREW_SCHEDULE_MAX_DAYS} days, starting no more than ${CREW_SCHEDULE_HISTORY_DAYS} days ago.`, 400);
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

/** The usernames an answer names as a lead: the shown crews' leads and the shown rows' leads, nothing else. */
export function scheduleLeads(crews, rows) {
  const ids = new Set();
  for (const crew of crews) if (typeof crew?.leadId === 'string') ids.add(assignmentKey(crew.leadId));
  for (const row of rows) if (typeof row?.crewLead === 'string') ids.add(assignmentKey(row.crewLead));
  ids.delete('');
  return ids;
}

/**
 * The schedule response body. `crews` are dispatchResources crew rows, `jobs` the dated jobs rows, `access` the
 * request's createJobAssignmentAccess and `names` maps a lower-case username to a display name, or is a function
 * that answers that map for a set of usernames (called once, after filtering, only when a shown lead needs a name).
 */
export async function crewSchedule({ session, env = {}, crews, jobs, access, names = {}, from, to, scope, now = new Date() }) {
  const all = scope === 'all', manager = hasBusinessAccess(session), today = denverToday(now);
  const crewRows = crews.filter(crew => crew?.recordType === 'crew' && fieldId(crew.id) && typeof crew.name === 'string' && crew.name.trim());
  const member = crew => [...(Array.isArray(crew.memberIds) ? crew.memberIds : []), crew.leadId].some(id => typeof id === 'string' && access.exactly(id));
  const mineCrews = new Set(crewRows.filter(crew => crew.status !== 'inactive' && member(crew)).map(crew => crew.id));
  const known = new Map(crewRows.map(crew => [crew.id, crew]));
  const shown = [];
  for (const job of jobs) {
    const visit = job?.type === 'walkthrough';
    if (!job || !(CREW_WORK.has(job.type) || visit) || job.recordType || !fieldId(job.id) || fieldCancelled(job)) continue;
    // REP-WALKTHROUGH: a Knock rep's own self-run visit leaves their schedule once their right to it ends.
    if (visit && !manager && !ownWalkthroughRight(session, env) && selfRunCardHidden(job, session, now)) continue;
    let open = null;
    for (const row of jobSegments(job)) {
      const days = windowDays(row, from, to);
      if (!days.length) continue;
      const mine = await access.assigned(row), crew = !visit && row.crewId ? known.get(row.crewId) || null : null;
      // An estimator's walkthrough is on their own schedule only.
      if (visit ? !mine : !all && !mine && !(crew && mineCrews.has(crew.id))) continue;
      // The job page opens for anyone on the job, whichever segment they work (/api/field-jobs checks the whole job).
      open ??= manager || await access.assigned(job);
      // A segment row is an unsplit job (jobSegments), so the projection reads its own window, crew and lead.
      // A walkthrough names no lead (it is the viewer's own visit), so it never costs a lead-name lookup.
      const view = crewJobProjection(row, { viewer: session.user, crewName: crew?.name || '' });
      // The customer's arrival window is the first visit's: a segment row on another date or time shows none.
      const firstVisit = !row.segmentId || row.date === job.date && row.time === job.time;
      shown.push({ crew, days, mine, canOpen: open, segmentId: row.segmentId || '', firstVisit, fieldStatus: visit ? '' : liveStatus(job, days, today), view: visit ? { ...view, crewLead: null } : view });
    }
  }
  const groups = [...known.values()].sort(byCrew).map(crew => ({ crew, items: shown.filter(item => item.crew === crew) }))
    .filter(group => group.items.length || mineCrews.has(group.crew.id) || all && group.crew.status !== 'inactive');
  // Display names only for the leads this answer shows; with none to resolve there is no read.
  const leads = scheduleLeads(groups.map(group => group.crew), shown.map(item => item.view));
  const resolved = typeof names === 'function' ? leads.size ? await names(leads) || {} : {} : names || {};
  const name = id => resolved[assignmentKey(id)] || text(id, 120);
  const rowView = ({ crew, days, mine, canOpen, segmentId, firstVisit, fieldStatus, view }) => ({
    id: view.id, ...(segmentId ? { segmentId } : {}), type: view.type, status: view.status, fieldStatus,
    date: view.date, endDate: view.endDate, time: view.time, endTime: view.endTime, arrivalWindow: firstVisit ? view.arrivalWindow : '', days,
    serviceType: view.serviceType, customer: firstName(view.customer), area: areaOf(view.address),
    crewId: crew ? crew.id : '', crewName: crew ? text(crew.name, 100) : text(view.crewName, 100),
    lead: view.crewLead ? name(view.crewLead) : crew?.leadId ? name(crew.leadId) : '',
    crewSize: view.assignedCrew.length, crewNeeded: Number.isFinite(view.crewNeeded) && view.crewNeeded > 0 ? view.crewNeeded : 1,
    mine, canOpen,
  });
  const crewView = crew => ({ id: crew.id, name: text(crew.name, 100), ...(text(crew.code, 40) ? { code: text(crew.code, 40) } : {}), lead: crew.leadId ? name(crew.leadId) : '',
    mine: mineCrews.has(crew.id), ...(Array.isArray(crew.serviceDays) ? { serviceDays: DAYS.filter(day => crew.serviceDays.includes(day)) } : {}) });
  return { ok: true, authority: 'employee_hub', scope, from, to, timeZone: 'America/Denver',
    viewer: { user: session.user, canViewAll: canViewAllSchedules(session, env) },
    groups: groups.map(group => ({ crew: crewView(group.crew), jobs: group.items.map(rowView).sort(byTime) })),
    unassigned: shown.filter(item => !item.crew).map(rowView).sort(byTime),
    coverage: { complete: true, asOf: now.toISOString() } };
}
