import { stripCrewMoney } from './crew-money.js';

// Only operational capture fields belong in the crew brief. Never spread the
// private review draft (pricing notes, approvals and customer questions).
const FIELDS = [
  ['donateItems', 'Donate'], ['sortMethod', 'Sorting method'],
  ['hazardPlan', 'Hazard handling / stop-work plan'], ['damageNotes', 'Existing damage'],
  ['measurements', 'Measurements'], ['equipment', 'Equipment notes'],
  ['specialItems', 'Special items'], ['finish', 'Finishing work'],
  ['shelfType', 'Shelf type'], ['shelfQty', 'Shelf quantity'], ['toteQty', 'Tote quantity'],
  // The vehicles the customer parks after the job, the tightest fit and the lowest rack height (crew/gameplan-vehicles.js).
  ['parkingPlan', 'Parking after the job'],
  ['crewSize', 'Estimated crew size'], ['estimatedJobMinutes', 'Estimated on-site minutes'],
  // EGC_QUOTE_BUILDER_ENABLED (D12): the man-hours the builder quote's Labor line sold, never its rate or amount.
  ['laborManHours', 'Man-hours sold'],
  // EGC_JOB_MATERIALS: the signed handoff's job breakdown lines (job-breakdown.js), removal, shelving, storage, cleaning.
  ['jobBreakdown', 'Job breakdown']
];

export function walkthroughCrewBrief(instructions) {
  if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) return [];
  return FIELDS.flatMap(([key, label]) => {
    const value = instructions[key];
    const text = key === 'laborManHours' ? (typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(2))} man-hour${value === 1 ? '' : 's'}` : '')
      : typeof value === 'string' ? value : Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : Number.isInteger(value) && value > 0 ? String(value) : '';
    const safe = stripCrewMoney(text).trim().slice(0, 6000);
    return safe ? [{ label, text: safe }] : [];
  });
}
