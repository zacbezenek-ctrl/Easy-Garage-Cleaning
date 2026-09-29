import { suggestedDurationMinutes } from './quote-duration.js';

/**
 * Suggested on-site length of a dispatch job (P1-DS-05). Pure: no clock, and
 * no I/O except withQuoteLines().
 *
 * The math is quote-duration.js over the LI-CORE line contract: every selected
 * (included) line of a SOLD estimate (status accepted or approved) gives
 * person-minutes = minutes per unit x quantity, where minutes per unit is
 * durationMinutes, else split.laborMinutes (a catalog item's installMinutes is
 * copied into both by catalogLine()). Draft, sent or declined quotes, deselected
 * optional lines, unchosen alternatives, discounts and tips add nothing. The
 * person-minutes are divided by the crew, setup is added and the result is
 * rounded up to 15 minutes and capped at one day.
 *
 * Precedence (source):
 *   1. a length recorded for the planned crew: durationOverride {minutes,
 *      reason} still equal to estimatedDurationMin, judged for the crew the
 *      job is planned for (durationOverride.crewSize, else the walkthrough's
 *      logistics.crew_size). The walkthrough manager's override (P2-05)
 *      reports duration_override; a length saved in dispatch
 *      (dispatchDurationOverride, source 'dispatch') reports
 *      estimated_duration. Another crew is recomputed from the lines.
 *   2. line_items          sold quote lines that carry minutes
 *   3. estimated_duration  job.estimatedDurationMin (15..10080)
 *   4. schedule_span       the saved Denver schedule (capped at one day, as
 *                          openings are)
 *   5. default             120 minutes
 * The crew is options.crewSize, else crewNeeded, else requiredCrewSize, else 1:
 * the fields the masked dispatch scan reads, so a list and a single-job read
 * agree. Recorded minutes (1 and 3) are rounded up to 15 like computed ones.
 *
 * Returns {minutes, source, crewSize, breakdown}. The breakdown names quote
 * lines and stays on the server: dispatch DTOs carry only dispatchDurationFields
 * (the minutes, the source, the line coverage and a cap flag), never an amount
 * or a price.
 */
export const DURATION_SOURCES = Object.freeze(['duration_override', 'line_items', 'estimated_duration', 'schedule_span', 'default']);
export const ESTIMATED_DURATION_MIN = Object.freeze({ min: 15, max: 10080 });
export const SOLD_ESTIMATE_STATUSES = Object.freeze(['accepted', 'approved']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const saved = job => whole(job?.estimatedDurationMin, ESTIMATED_DURATION_MIN.min, ESTIMATED_DURATION_MIN.max) ? job.estimatedDurationMin : null;
const sold = job => plain(job?.estimate) && SOLD_ESTIMATE_STATUSES.includes(String(job.estimate.status || '').toLowerCase());
const EMPTY = Object.freeze({ suggestedDurationMin: null, durationSource: null, durationCoverage: null, durationCapped: null });

/** The crew a dispatch job is planned for (1 when none is saved). */
export function dispatchCrewSize(job) {
  for (const value of [job?.crewNeeded, job?.requiredCrewSize]) if (whole(value, 1, 20)) return value;
  return 1;
}

/** The record a dispatch save of estimatedDurationMin writes beside it, so the
 * saved length outranks the quote lines for the crew it was set for. */
export function dispatchDurationOverride(minutes, crewSize, actor, now) {
  return { minutes, reason: 'Set in dispatch', source: 'dispatch', crewSize, recordedBy: actor, recordedAt: now };
}

function recordedLength(job) {
  const override = job?.durationOverride, minutes = saved(job);
  if (minutes === null || !plain(override) || typeof override.reason !== 'string' || !override.reason.trim() || override.minutes !== minutes) return null;
  const crewSize = override.crewSize !== undefined ? override.crewSize : job?.logistics?.crew_size;
  return whole(crewSize, 1, 20) ? { minutes, crewSize, source: override.source === 'dispatch' ? 'estimated_duration' : 'duration_override' } : null;
}

function recorded(base, source, minutes) {
  const step = base.breakdown.roundToMinutes, rounded = Math.ceil(minutes / step) * step;
  return { minutes: rounded, source, crewSize: base.crewSize, breakdown: { ...base.breakdown, rawMinutes: minutes, roundedMinutes: rounded, clamped: null, ...(source === 'duration_override' ? { overridden: { source: base.source, minutes: base.minutes } } : {}) } };
}

/** `interval` is an already-computed scheduleInterval(job), when the caller has one. */
export function suggestedDuration(job, { crewSize, settings, interval } = {}) {
  const planned = crewSize ?? dispatchCrewSize(job);
  const base = suggestedDurationMinutes(sold(job) ? job.estimate.lineItems : undefined, { crewSize: planned, settings, job, ...(interval !== undefined ? { interval } : {}) });
  const length = recordedLength(job);
  if (length && length.crewSize === planned) return recorded(base, length.source, length.minutes);
  // quote-duration trusts at most one day (the walkthrough range); dispatch
  // also keeps a saved multi-day expectation of up to a week.
  if (['schedule_span', 'default'].includes(base.source) && saved(job) !== null) return recorded(base, 'estimated_duration', saved(job));
  return base;
}

const unread = new WeakSet();
/** DTO fields for projectDispatchJob. Unreadable data gives nulls, never a guess.
 * durationCoverage is 'partial' when some sold lines carry no minutes and
 * durationCapped is true when the total was cut to one day: both undercount. */
export function dispatchDurationFields(job, interval) {
  if (unread.has(job)) return { ...EMPTY };
  try {
    const { minutes, source, breakdown } = suggestedDuration(job, { interval });
    return { suggestedDurationMin: minutes, durationSource: source, durationCoverage: source === 'line_items' ? breakdown.coverage : null, durationCapped: breakdown.clamped === 'max' };
  } catch { return { ...EMPTY }; }
}

/** Masked jobs scans leave quote lines out: they are large and carry money. A
 * dispatch list reads them (store.quoteLines) only for the sold jobs it
 * projects. A job whose lines are unreadable or changed since the scan gets a
 * null suggestion. Stores without quoteLines already hold whole records. */
export async function withQuoteLines(store, jobs) {
  if (typeof store?.quoteLines !== 'function' || !jobs.some(sold)) return jobs;
  const found = await store.quoteLines(jobs.filter(sold).map(job => job.id)).catch(() => null);
  return jobs.map(job => {
    if (!sold(job)) return job;
    const row = found instanceof Map ? found.get(job.id) : null;
    if (row && row.revision === job.revision) return { ...job, estimate: { ...job.estimate, lineItems: plain(row.estimate) ? row.estimate.lineItems : undefined } };
    const copy = { ...job };
    unread.add(copy);
    return copy;
  });
}
