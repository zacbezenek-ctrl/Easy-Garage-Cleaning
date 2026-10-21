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
  ['jobBreakdown', 'Job breakdown'],
  // The items the job needs: the goods sold (the signed quote's products, jobInstructions.materials {name, quantity},
  // else a gameplan's soldGoods lines), names and counts only, and the walkthrough's bring list (EGC_JOB_MATERIALS).
  ['soldGoods', 'Sold goods'], ['bringList', 'Bring']
];
const named = item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim();
const count = item => typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 1 ? `${Number(item.quantity.toFixed(2))} × ${item.name.trim()}` : item.name.trim();
function soldGoods(instructions) {
  const materials = Array.isArray(instructions.materials) ? instructions.materials.filter(named).slice(0, 60).map(count) : [];
  return materials.length ? materials : Array.isArray(instructions.soldGoods) ? instructions.soldGoods.filter(item => typeof item === 'string') : [];
}

/** options.materials: the job's materials (EGC_JOB_MATERIALS). The crew page lists them in its materials card, so a job
 * that has the quote's goods there (quote-… ids) skips Sold goods, and one with a stock grab list skips Bring: each item
 * is named once. */
export function walkthroughCrewBrief(instructions, { materials = [] } = {}) {
  if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) return [];
  const listed = Array.isArray(materials) ? materials.filter(item => item && typeof item === 'object') : [];
  const skip = new Set([...(listed.some(item => String(item.id || '').startsWith('quote-')) ? ['soldGoods'] : []), ...(listed.some(item => item.source === 'stock') ? ['bringList'] : [])]);
  return FIELDS.filter(([key]) => !skip.has(key)).flatMap(([key, label]) => {
    const value = key === 'soldGoods' ? soldGoods(instructions) : instructions[key];
    const text = key === 'laborManHours' ? (typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(2))} man-hour${value === 1 ? '' : 's'}` : '')
      : typeof value === 'string' ? value : Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : Number.isInteger(value) && value > 0 ? String(value) : '';
    const safe = stripCrewMoney(text).trim().slice(0, 6000);
    return safe ? [{ label, text: safe }] : [];
  });
}
