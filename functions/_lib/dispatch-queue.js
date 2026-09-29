/* FIX-DISPATCH-QUEUE: Dispatch's To schedule queue. Active customer work with no date waits there, oldest first by
   when it was sold (funnelSale.soldAt: the live sale FUN-03 records for a signed walkthrough or a portal approval, only
   when funnelSale.jobId names this job, as liveSale() requires), else when its estimate was accepted
   (estimate.acceptedAt, customerApproval.approvedAt), else when the job was created. Each row says where the work came
   from: a Walkthrough sale, a Portal approval, a Jobber import or the Hub, and an imported Jobber job
   (scheduleSource 'jobber_import') shows the first visit Jobber had for it, even after the customer approves it online.

   needsDispatchReview (optional; legacy jobs have none and behave as before) flags undated work the office has not
   booked yet: an online approval (customer-portal.js approve_estimate, reason 'portal_approval') and an imported Jobber
   job (jobber-import-map.js futureJobRecord, 'jobber_import'). 'sold_schedule_later' is reserved for a signed sale
   saved to schedule later: walkthrough-handoff.js has no undated path yet, and the unit that adds one spreads
   dispatchReviewPatch('sold_schedule_later', now) into that create. The first save that leaves the job scheduled
   clears it, with who and when: a dispatch save (dispatch-service.js) or a bridge schedule update (MCP
   egc.schedule_visit, operations-scheduling.js). Queue facts are read-only and are added only to the Hub's GET
   /api/dispatch board (dispatchOverview option readiness, which also sends queueFacts:true so the page lists exactly
   the jobs that carry them), never to the signed hub.dispatch.overview bridge. They carry no money: a sale's amount
   and an imported Jobber job's value are never read (QUEUE_JOB_FIELDS is a field mask). */
import { denverToday, scheduleInterval, validDate } from './dispatch-time.js';
import { walkthroughClosed } from './walkthrough-state.js';

export const DISPATCH_REVIEW_REASONS = Object.freeze(['portal_approval', 'sold_schedule_later', 'jobber_import']);
export const QUEUE_SOURCES = Object.freeze(['walkthrough', 'portal', 'jobber', 'hub']);
// The job fields the queue reads beyond the board's own, as Firestore mask paths (dispatch-storage.js JOB_FIELDS).
export const QUEUE_JOB_FIELDS = Object.freeze(['needsDispatchReview', 'dispatchReviewReason', 'funnelSale.soldAt', 'funnelSale.jobId', 'estimate.acceptedAt', 'customerApproval.approvedAt', 'customerApproval.source', 'jobber.visits']);
const TERMINAL = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const VISIT_TYPES = new Set(['job', 'walkthrough', 'cleanout', 'reorg']);
const TIME = /^\d{2}:\d{2}$/, INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = job => String(job?.pipelineStatus || job?.status || 'unscheduled').toLowerCase();
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
// An ISO instant, or a bare date (older browser writes) read as noon UTC, which is the same Denver date.
const instant = value => INSTANT.test(value ?? '') && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : validDate(value) ? `${value}T12:00:00.000Z` : null;
const dayNumber = date => Date.parse(`${date}T12:00:00Z`) / 86400000;

/** Active customer work with no date: what To schedule lists (and what the board's other views leave to it). A closed
 * walkthrough (WT-OUTCOME walkthrough-state.js: a converted job, a final outcome or walkthroughCompletedAt) is finished work,
 * even with no date and a status still 'scheduled', so it never waits here. */
export const queued = job => Boolean(job) && VISIT_TYPES.has(job.type) && !job.recordType && safeId(job.id) && !job.date && !TERMINAL.has(state(job)) && !walkthroughClosed(job);

/** The review flag a writer adds when sold or approved work lands with no date. `now` is the ISO instant of the write. */
export function dispatchReviewPatch(reason, now) {
  if (!DISPATCH_REVIEW_REASONS.includes(reason) || !INSTANT.test(now ?? '')) throw new TypeError('A dispatch review needs a known reason and the time it was raised.');
  return { needsDispatchReview: true, dispatchReviewReason: reason, dispatchReviewAt: now };
}

/** The fields that clear the review flag when a dispatch save leaves `current` scheduled (`scheduled`: the saved
 * interval); {} otherwise. The reason stays as the record of where the work came from. */
export function dispatchReviewCleared(current, scheduled, actor, now) {
  return current?.needsDispatchReview === true && scheduled ? { needsDispatchReview: false, dispatchReviewClearedAt: now, dispatchReviewClearedBy: actor } : {};
}

/** Where the work came from: the review reason first, then the job's own record of its origin. */
export function queueSource(job) {
  const reason = job?.dispatchReviewReason;
  if (reason === 'portal_approval') return 'portal';
  if (reason === 'sold_schedule_later') return 'walkthrough';
  if (reason === 'jobber_import' || job?.scheduleSource === 'jobber_import') return 'jobber';
  if (safeId(job?.sourceWalkthroughId)) return 'walkthrough';
  if (job?.customerApproval?.source === 'customer_portal') return 'portal';
  return 'hub';
}

// The first dated visit Jobber had for an imported job (jobber-import-map.js keeps them sorted), as Denver wall clock.
// usable: it has a start and a later end Dispatch can book as they are; past: its date is before today.
function jobberVisit(job, today) {
  const visit = (Array.isArray(job?.jobber?.visits) ? job.jobber.visits : []).find(row => plain(row) && validDate(row.date));
  if (!visit) return null;
  const endDate = validDate(visit.endDate) ? visit.endDate : visit.date, time = TIME.test(visit.time ?? '') ? visit.time : '', endTime = TIME.test(visit.endTime ?? '') ? visit.endTime : '';
  const allDay = visit.allDay === true, review = visit.timeNeedsReview === true;
  return { date: visit.date, time, endDate, endTime, ...(allDay ? { allDay: true } : {}), ...(review ? { timeNeedsReview: true } : {}),
    usable: !allDay && !review && Boolean(time && endTime && scheduleInterval({ date: visit.date, time, endDate, endTime })), past: visit.date < today };
}

/** A queued job's To schedule facts at `now` (a Date or ISO instant): since (ISO instant, or null) and sinceKind
 * ('sold' | 'approved' | 'created' | null), ageDays (whole Denver days since then, never negative), source
 * (QUEUE_SOURCES) and, for an imported Jobber job, jobber (its first visit). */
export function queueFacts(job, now) {
  // A funnelSale copied onto another job (a cloned visit) names that job: it is not this job's sale (job-funnel-events.js liveSale).
  const own = plain(job?.funnelSale) && typeof job.id === 'string' && job.id !== '' && job.funnelSale.jobId === job.id;
  const today = denverToday(new Date(now)), sold = own ? instant(job.funnelSale.soldAt) : null, accepted = instant(job?.estimate?.acceptedAt) || instant(job?.customerApproval?.approvedAt), created = instant(job?.createdAt);
  // An imported Jobber job keeps the visit Jobber had even when an online approval relabels where it came from.
  const since = sold || accepted || created, source = queueSource(job), visit = source === 'jobber' || job?.scheduleSource === 'jobber_import' ? jobberVisit(job, today) : null;
  return { since, sinceKind: sold ? 'sold' : accepted ? 'approved' : created ? 'created' : null, ageDays: since ? Math.max(0, dayNumber(today) - dayNumber(denverToday(new Date(since)))) : null, source, ...(visit ? { jobber: visit } : {}) };
}

/** To schedule order: oldest first by since, then the earlier Jobber visit, then id; work with no known date is last. */
export function queueOrder(left, right) {
  const key = job => [job?.queue?.since || '9999', job?.queue?.jobber?.date || '9999', String(job?.id || '')];
  const [a, b] = [key(left), key(right)];
  return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** The projected dispatch jobs with `queue` (queueFacts) on each queued one, the queued ones in queueOrder among
 * themselves; every other job keeps its place. `raws` are the stored jobs the DTOs were projected from (same ids). */
export function withQueueFacts(raws, jobs, now) {
  const byId = new Map(raws.map(job => [job.id, job]));
  const output = jobs.map(job => { const raw = byId.get(job.id); return raw && queued(raw) ? { ...job, queue: queueFacts(raw, now) } : job; });
  const ordered = output.filter(job => job.queue).sort(queueOrder);
  return output.map(job => job.queue ? ordered.shift() : job);
}
