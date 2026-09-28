import { scheduleInterval } from './dispatch-time.js';
import { included, normalizeLineItems } from './quote-model.js';

/**
 * Suggested on-site duration from canonical quote lines. Pure; shared by the
 * quote builder and the dispatch duration suggestion.
 *
 * Line items: for each SELECTED (included) charge line, minutes per unit are
 * durationMinutes, else split.laborMinutes; times quantity they give
 * person-minutes. Wall minutes = setupMinutes + ceil(personMinutes / crewSize),
 * rounded UP to roundToMinutes and clamped to [minMinutes, maxMinutes].
 *
 * Fallback chain when no selected line carries minutes (these are already
 * wall-clock and are not divided by crew):
 *   1. job.estimatedDurationMin (walkthrough estimate, 15..1440)
 *   2. the saved schedule span (Denver date/time/endDate/endTime)
 *   3. settings.defaultMinutes
 * Every result carries {minutes, source, crewSize, breakdown}.
 */

export const DURATION_DEFAULTS = Object.freeze({ crewSize: 1, setupMinutes: 0, roundToMinutes: 15, minMinutes: 15, maxMinutes: 1440, defaultMinutes: 120 });
const LIMITS = { crewSize: [1, 20], setupMinutes: [0, 480], roundToMinutes: [1, 120], minMinutes: [0, 2880], maxMinutes: [15, 2880], defaultMinutes: [15, 2880] };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code: `quote_${code}`, status: 400 });
const whole = (value, [min, max]) => Number.isSafeInteger(value) && value >= min && value <= max;

function durationSettings(settings = {}) {
  if (!plain(settings)) throw fail('invalid_duration_settings', 'Duration settings must be an object.');
  const merged = { ...DURATION_DEFAULTS };
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in DURATION_DEFAULTS) || !whole(value, LIMITS[key])) throw fail('invalid_duration_settings', `Duration setting ${key} is invalid.`);
    merged[key] = value;
  }
  if (merged.minMinutes > merged.maxMinutes) throw fail('invalid_duration_settings', 'The minimum duration cannot exceed the maximum.');
  return merged;
}

function jobCrew(job) {
  for (const value of [job?.crewNeeded, job?.crewSize, job?.logistics?.crew_size]) if (whole(value, LIMITS.crewSize)) return value;
  return null;
}

function finish(rawMinutes, settings) {
  const rounded = Math.ceil(rawMinutes / settings.roundToMinutes) * settings.roundToMinutes;
  const minutes = Math.min(settings.maxMinutes, Math.max(settings.minMinutes, rounded));
  return { minutes, rawMinutes, roundedMinutes: rounded, roundToMinutes: settings.roundToMinutes, clamped: minutes > rounded ? 'min' : minutes < rounded ? 'max' : null };
}

export function suggestedDurationMinutes(lineItems, { crewSize, setupMinutes, baseMinutes, settings, job } = {}) {
  const config = durationSettings(settings);
  if (crewSize !== undefined && !whole(crewSize, LIMITS.crewSize)) throw fail('invalid_crew_size', 'Crew size must be a whole number from 1 to 20.');
  const setup = setupMinutes ?? baseMinutes ?? config.setupMinutes;
  if (!whole(setup, LIMITS.setupMinutes)) throw fail('invalid_setup_minutes', 'Setup minutes must be a whole number from 0 to 480.');
  const crew = crewSize ?? jobCrew(job) ?? config.crewSize;
  const items = [], unestimated = [];
  let personMinutes = 0;
  for (const line of normalizeLineItems(lineItems).lineItems) {
    if (!included(line) || ['discount', 'tip'].includes(line.kind)) continue;
    const perUnit = line.durationMinutes ?? line.split?.laborMinutes ?? null;
    if (perUnit === null) { unestimated.push(line.id); continue; }
    const minutes = Math.ceil(perUnit * Math.round(line.quantity * 100) / 100);
    personMinutes += minutes;
    items.push({ id: line.id, name: line.name, quantity: line.quantity, minutesPerUnit: perUnit, minutes, from: line.durationMinutes === null ? 'split.laborMinutes' : 'durationMinutes' });
  }
  if (personMinutes > 0) {
    const crewMinutes = Math.ceil(personMinutes / crew), result = finish(setup + crewMinutes, config);
    return { minutes: result.minutes, source: 'line_items', crewSize: crew, breakdown: { ...result, personMinutes, crewMinutes, setupMinutes: setup, items, unestimated, coverage: unestimated.length ? 'partial' : 'complete' } };
  }
  const span = job ? scheduleInterval(job) : null;
  const [source, raw] = whole(job?.estimatedDurationMin, [15, 1440]) ? ['estimated_duration', job.estimatedDurationMin] : span ? ['schedule_span', Math.round((span.end - span.start) / 60000)] : ['default', config.defaultMinutes];
  const result = finish(raw, config);
  return { minutes: result.minutes, source, crewSize: crew, breakdown: { ...result, personMinutes: 0, crewMinutes: null, setupMinutes: 0, items, unestimated, coverage: 'fallback' } };
}

/** Dispatch helper: the suggestion for a saved job from its estimate lines and schedule. */
export const jobDurationSuggestion = (job, options = {}) => suggestedDurationMinutes(job?.estimate?.lineItems, { ...options, job });
