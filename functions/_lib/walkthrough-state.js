import { validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';

// WT-OUTCOME: where a walkthrough visit stands, from its saved FUN-05 record, for every
// list that shows it (Dispatch, the Hub's Walkthroughs and Today, the rep's day, crew
// home, the gameplan's Today list). A walkthrough is closed once it has a converted job,
// a final outcome or walkthroughCompletedAt: lists then show a badge and a link, never
// Start. A no-show or rescheduled outcome covers only its occurrence; once Dispatch moves
// the visit (FUN-05 rebookPending) the visit is open again. The browser copy for raw
// Firestore rows is employee-walkthrough-state.js (tests/wt-outcome.test.mjs keeps both
// in step).

export const WALKTHROUGH_FINAL_OUTCOMES = Object.freeze(['sold_on_site', 'quote_to_follow', 'not_interested']);
export const WALKTHROUGH_REBOOKABLE = new Set(['customer_no_show', 'rescheduled']);
export const WALKTHROUGH_STATES = Object.freeze(['open', 'no_show', 'rescheduled', 'sold', 'quote', 'lost', 'done', 'cancelled']);
const CLOSED = new Set(['sold', 'quote', 'lost', 'done']), FINAL = new Set(WALKTHROUGH_FINAL_OUTCOMES);
const CANCELLED = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'no-show']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:secure_|_egc_)/.test(value);
const outcomeOf = visit => plain(visit?.walkthroughOutcome) ? visit.walkthroughOutcome : null;

// Reason labels as the rep picks them on the gameplan's Finish screen (crew/gameplan-recorder.js REASONS).
export const WALKTHROUGH_REASON_LABELS = Object.freeze({
  lost: Object.freeze({ price: 'Price', timing: 'Timing', chose_competitor: 'Chose a competitor', diy: 'Doing it themselves', no_response: 'No response', not_a_fit: 'Not a fit for us', other: 'Other', other_legacy: 'Other' }),
  noShow: Object.freeze({ customer_not_home: 'Customer not home', no_access: 'No access', unreachable: 'Could not reach the customer', wrong_address: 'Wrong address', other: 'Other', other_legacy: 'Other' }),
  reschedule: Object.freeze({ customer_request: 'Customer asked to move it', weather: 'Weather', crew_unavailable: 'Rep or crew unavailable', previous_job_overran: 'Previous visit ran over', access_issue: 'Access problem', vehicle_or_equipment: 'Vehicle or equipment', other: 'Other', other_legacy: 'Other' }),
});
// A walkthrough no-show reason as the FUN-02 move reason Dispatch asks for when the visit is rebooked.
const NO_SHOW_MOVE = { customer_not_home: ['customer_request', 'customer'], unreachable: ['customer_request', 'customer'], no_access: ['access_issue', 'customer'], wrong_address: ['other', null], other: ['other', null] };
const MOVE_BY = { customer_request: 'customer', crew_unavailable: 'company', previous_job_overran: 'company', vehicle_or_equipment: 'company' };

/** The occurrence a visit is on: its Denver wall start and, once FUN-02 counts placements,
 * its scheduleOccurrence. `number` never goes down across a visit's occurrences. */
export function walkthroughOccurrence(visit, previous = 0) {
  const date = validDate(visit.date) ? visit.date : null, time = typeof visit.time === 'string' && /^\d\d:\d\d$/.test(visit.time) ? visit.time : null;
  const counter = Number.isInteger(visit.scheduleOccurrence) && visit.scheduleOccurrence >= 1 && visit.scheduleOccurrence <= 1000 ? visit.scheduleOccurrence : null;
  return { number: Math.min(1000, Math.max(counter ?? 1, previous + 1)), date, time, startAt: date && time ? localInstant(date, time) : null, scheduleOccurrence: counter };
}
/** Dispatch moved the visit to another start (or FUN-02 counted a new placement) since that occurrence. */
export function walkthroughMoved(snapshot, visit) {
  if (!plain(snapshot)) return false;
  const current = walkthroughOccurrence(visit);
  return Boolean(current.startAt) && (current.startAt !== snapshot.startAt || current.scheduleOccurrence !== null && Number.isInteger(snapshot.scheduleOccurrence) && current.scheduleOccurrence !== snapshot.scheduleOccurrence);
}
/** The saved outcome belongs to an earlier occurrence: a no-show or reschedule the visit has since been moved from. */
export const walkthroughRebooked = visit => { const outcome = outcomeOf(visit); return Boolean(outcome && WALKTHROUGH_REBOOKABLE.has(outcome.outcome) && walkthroughMoved(outcome.occurrence, visit)); };

/** {outcome, reasonCode, finishedAt} of the saved outcome, or null. No performer, notes or timecard detail. */
export function walkthroughOutcomeSummary(visit) {
  const outcome = outcomeOf(visit);
  if (!outcome || typeof outcome.outcome !== 'string' || !outcome.outcome) return null;
  return { outcome: text(outcome.outcome, 40), reasonCode: typeof outcome.reasonCode === 'string' && outcome.reasonCode ? text(outcome.reasonCode, 40) : null, finishedAt: typeof outcome.finishedAt === 'string' && outcome.finishedAt ? text(outcome.finishedAt, 40) : null };
}

/** The shared closed rule: a converted job, a final outcome or walkthroughCompletedAt. */
export function walkthroughClosed(visit) {
  if (!visit || visit.type !== 'walkthrough') return false;
  const outcome = outcomeOf(visit);
  return safeId(visit.convertedJobId) || FINAL.has(outcome?.outcome) || typeof visit.walkthroughCompletedAt === 'string' && Boolean(visit.walkthroughCompletedAt.trim());
}

const label = (list, code) => WALKTHROUGH_REASON_LABELS[list][code] || '';

/**
 * Where a walkthrough stands: {state, closed, badge, rebookPending}.
 *   state  'sold' | 'quote' | 'lost' | 'done' (closed), 'no_show' | 'rescheduled' (its outcome waits for a rebook),
 *          'cancelled' (cancelled in Dispatch) or 'open' (Start is offered)
 *   badge  'Sold → open job', 'Quote to follow', 'Lost: <reason>', 'No-show · rebook', 'Rescheduled · rebook',
 *          'Walkthrough done', 'Cancelled', or '' for an open visit
 */
export function walkthroughStatus(visit) {
  const outcome = outcomeOf(visit), rebookPending = walkthroughRebooked(visit), current = outcome && !rebookPending ? outcome.outcome : '';
  const stage = String(visit?.pipelineStatus || visit?.status || '').toLowerCase();
  let state = 'open';
  if (safeId(visit?.convertedJobId) || current === 'sold_on_site') state = 'sold';
  else if (current === 'not_interested') state = 'lost';
  else if (current === 'quote_to_follow') state = 'quote';
  else if (walkthroughClosed(visit)) state = 'done';
  else if (CANCELLED.has(stage)) state = 'cancelled';
  else if (current === 'customer_no_show') state = 'no_show';
  else if (current === 'rescheduled') state = 'rescheduled';
  const reason = state === 'lost' ? label('lost', outcome.reasonCode) : '';
  const badge = { sold: 'Sold → open job', quote: 'Quote to follow', lost: reason ? `Lost: ${reason}` : 'Lost', done: 'Walkthrough done', cancelled: 'Cancelled', no_show: 'No-show · rebook', rescheduled: 'Rescheduled · rebook', open: '' }[state];
  return { state, closed: CLOSED.has(state), badge, rebookPending };
}

/** What Dispatch prefills when a visit is rebooked: {reasonCode, initiatedBy, label, missedOn}. A walkthrough
 * no-show or reschedule moves the same visit with a FUN-02 move reason; a service-job no-show is booked again
 * (schedule.create takes no reason), so only its label and date go into the new visit's notes. */
export function rebookPrefill(visit) {
  if (visit?.type === 'walkthrough') {
    const { state } = walkthroughStatus(visit), outcome = outcomeOf(visit);
    if (state !== 'no_show' && state !== 'rescheduled') return null;
    const code = typeof outcome.reasonCode === 'string' ? outcome.reasonCode : '', missedOn = validDate(outcome.occurrence?.date) ? outcome.occurrence.date : validDate(visit.date) ? visit.date : null;
    if (state === 'rescheduled') return { reasonCode: label('reschedule', code) ? code : null, initiatedBy: MOVE_BY[code] || null, label: label('reschedule', code), missedOn };
    const [reasonCode, initiatedBy] = NO_SHOW_MOVE[code] || [null, null];
    return { reasonCode, initiatedBy, label: label('noShow', code), missedOn };
  }
  const stage = String(visit?.pipelineStatus || visit?.status || '').toLowerCase();
  if (!visit || !['no_show', 'noshow', 'no-show'].includes(stage)) return null;
  return { reasonCode: null, initiatedBy: null, label: label('noShow', visit.noShowReasonCode), missedOn: validDate(visit.date) ? visit.date : null };
}

/** The walkthrough fields a dispatch, calendar or crew DTO carries: the outcome summary, the converted job,
 * rebookPending, the state and badge above, and the rebook prefill (only the prefill for a service-job no-show).
 * A walkthrough with no outcome, converted job or walkthroughCompletedAt adds nothing, so its DTO is exactly the
 * legacy one and a reader treats the missing walkthroughState as 'open'. No money, notes or performer. */
export function walkthroughStatusFields(visit) {
  if (visit?.type !== 'walkthrough') {
    const rebook = rebookPrefill(visit);
    return rebook ? { rebook } : {};
  }
  return !outcomeOf(visit) && !safeId(visit.convertedJobId) && !walkthroughClosed(visit) ? {} : statusFields(visit);
}
function statusFields(visit) {
  const { state, closed, badge, rebookPending } = walkthroughStatus(visit), rebook = rebookPrefill(visit);
  return { walkthroughOutcome: walkthroughOutcomeSummary(visit), convertedJobId: safeId(visit.convertedJobId) ? visit.convertedJobId : null, rebookPending,
    walkthroughState: state, walkthroughClosed: closed, walkthroughBadge: badge, ...(rebook ? { rebook } : {}) };
}

/** The rep's read-only walkthrough card (/api/field-jobs): time, arrival window, address, the customer's phone
 * and where the visit stands. No estimate, notes, signature or provider ids. convertedJobOpen says the viewer can
 * open the sold job (the caller checks it as the job page would); otherwise the card links to the walkthrough. */
export function walkthroughCard(visit, { convertedJobOpen = false } = {}) {
  const field = (key, max) => text(visit[key], max), status = statusFields(visit);
  return { id: visit.id, type: 'walkthrough', customer: field('customer', 200), phone: field('phone', 100), address: field('address', 1000),
    date: field('date', 10), time: field('time', 8), endDate: field('endDate', 10) || field('date', 10), endTime: field('endTime', 8),
    arrivalWindow: field('arrivalWindow', 200), arrivalWindowStart: field('arrivalWindowStart', 8), arrivalWindowEnd: field('arrivalWindowEnd', 8),
    status: String(visit.pipelineStatus || visit.status || 'scheduled').toLowerCase().slice(0, 40), ...status, convertedJobOpen: convertedJobOpen === true && Boolean(status.convertedJobId) };
}
